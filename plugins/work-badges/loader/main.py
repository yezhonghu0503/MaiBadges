"""Explicit, loopback-only role badge loader. Importing does not contact an app.

The first adapter uses confirmed, exact document titles. A CDP window ID is never
treated as a conversation ID. All browser/transport tests use memory substitutes.
"""
from __future__ import annotations

import argparse
import base64
from collections import OrderedDict
from contextlib import contextmanager, nullcontext
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import sqlite3
import stat
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit
import uuid

from transport import CDPConnection, fetch_targets, validate_websocket_url

PLUGIN = Path(__file__).resolve().parent.parent
DEFAULT_STATE = Path.home() / 'Library/Application Support/MaiBadges'
SERVICE = 'mai-work-badges-loader/2'
API = 'MaiWorkBadgeRuntime'
BRAND = 'mai-work-badges/2'
MAIN_URL = 'app://-/index.html'
MAX_JSON = 65536
PROBE_INTERVAL = 0.25
DISCOVERY_INTERVAL = 2.0
HEARTBEAT_INTERVAL = 2.0
REGISTRY_REFRESH_INTERVAL = 2.0
ASSET_REVALIDATION_INTERVAL = 2.0
ASSET_CACHE_ITEMS = 6
ASSET_SIGNATURE_CACHE_ITEMS = 128
SIDEBAR_CACHE_ITEMS = 64
SIDEBAR_PACKET_BYTES = 6 * 1024 * 1024
ASSET_CACHE_BYTES = 32 * 1024 * 1024
ASSET_STAT_ENTRIES = 512
ASSET_STAT_DEPTH = 8
IMAGE_ID = re.compile(r'[a-f0-9]{64}\Z')
GENERIC_TITLES = frozenset(('chatgpt', 'codex', 'openai', 'chatgpt powered by codex & owl'))
BLOCKED_ERRORS = frozenset(('page-evaluation-failed', 'foreign-global-conflict', 'target-page-changed',
                           'invalid-own-controller-result', 'own-controller-not-mounted', 'own-controller-failed'))


def read_json(path, default=None):
    try:
        if path.is_symlink() or path.stat().st_size > MAX_JSON:
            raise ValueError('本包设置文件归属或大小无效。')
        value = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(value, dict):
            raise ValueError('本包设置必须是 JSON 对象。')
        return value
    except FileNotFoundError:
        return default


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main_url(value):
    return isinstance(value, str) and value == MAIN_URL


def candidates(targets):
    if not isinstance(targets, list):
        raise ValueError('调试入口返回的目标列表无效。')
    found = {}
    for item in targets:
        if not isinstance(item, dict) or item.get('type') != 'page' or not main_url(item.get('url')):
            continue
        identifier, title = item.get('id'), item.get('title', '')
        if not isinstance(identifier, str) or not identifier or len(identifier) > 256:
            continue
        if not isinstance(title, str) or len(title) > 1000 or not isinstance(item.get('webSocketDebuggerUrl'), str):
            continue
        if identifier in found and found[identifier] != item:
            raise ValueError('目标列表出现冲突，已停止。')
        found[identifier] = item
    return list(found.values())


def select_target(targets, selection):
    pages = candidates(targets)
    for key, expected in (('id', selection['preferredId']), ('title', selection['titleHint'])):
        matching = [page for page in pages if page[key] == expected]
        if len(matching) == 1:
            return matching[0]
    if len(pages) == 1:
        return pages[0]
    if pages:
        raise ValueError('multiple-main-windows')
    return None


def validate_target_endpoint(target, port):
    endpoint = validate_websocket_url(target['webSocketDebuggerUrl'], port)
    if urlsplit(endpoint).path != '/devtools/page/' + target['id']:
        raise ValueError('目标编号与调试端点不一致。')
    return endpoint


def layout_only(value):
    clean = {}
    if not isinstance(value, dict):
        return clean
    for key in ('x', 'y', 'width'):
        number = value.get(key)
        if (isinstance(number, (int, float)) and not isinstance(number, bool) and math.isfinite(number)
                and abs(number) <= 1000000 and (key != 'width' or 200 <= number <= 320)):
            clean[key] = number
    return clean


def card_state_only(value):
    if not isinstance(value, dict):
        return {}
    return {key: value[key] for key in ('flipped', 'collapsed') if type(value.get(key)) is bool}


def valid_scope(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except ValueError:
        return False


def config_at(state_dir):
    config = read_json(state_dir / 'config.json')
    if not config or config.get('schema') != 1 or not valid_scope(config.get('scope')):
        raise ValueError('请先运行 enroll，由你选择聊天主窗口。')
    port, target = config.get('port'), config.get('target')
    if type(port) is not int or not 1024 <= port <= 65535 or not isinstance(target, dict):
        raise ValueError('加载器设置无效，请重新 enroll。')
    if not main_url(target.get('url')) or not all(isinstance(target.get(key), str) and target[key] for key in ('preferredId', 'titleHint')):
        raise ValueError('主窗口选择无效，请重新 enroll。')
    return config


def context_at(target, state, now=None):
    title = state.get('title')
    if not isinstance(title, str) or not title.strip() or '\x00' in title or len(title) > 1000 or title.strip().casefold() in GENERIC_TITLES:
        return None
    # Exact title is an explicit fallback, not a stable chat/thread identifier.
    return {'windowId': target['id'], 'title': title, 'threadKey': None,
            'contextKey': 'title:' + title, 'seenAt': time.time() if now is None else now,
            'url': MAIN_URL}


def runtime_at(plugin=PLUGIN):
    data = (plugin / 'runtime/renderer.js').read_bytes()
    if not data or len(data) > 2 * 1024 * 1024:
        raise ValueError('工牌运行资源大小无效。')
    font = (plugin / 'assets/BricolageGrotesque.ttf').read_bytes()
    if not font or len(font) > 2 * 1024 * 1024:
        raise ValueError('工牌字体资源大小无效。')
    return data.decode('utf-8'), hashlib.sha256(data).hexdigest(), 'data:font/ttf;base64,' + base64.b64encode(font).decode('ascii')


def portrait_foreground(image_id):
    if str(PLUGIN) not in sys.path:
        sys.path.insert(0, str(PLUGIN))
    from backend.holo_assets import display_layers
    return display_layers(image_id)


def _file_stamp(path):
    """No-follow metadata detects replacement and same-size/mtime edits."""
    try:
        value = path.lstat()
        return (value.st_mode, value.st_dev, value.st_ino, value.st_size,
                value.st_mtime_ns, value.st_ctime_ns)
    except FileNotFoundError:
        return None


def asset_signature(registry, image_id, plugin=PLUGIN):
    """Bounded stat-only invalidation; uncertain sources are never memoized.

    The complete owned material tree is stamped, including manifest discovery,
    so adding a second matching manifest or changing a currently unused plane
    also invalidates a packet. Links are recorded, never followed.
    """
    if not isinstance(image_id, str) or not IMAGE_ID.fullmatch(image_id):
        return None
    root = getattr(registry, 'assets_dir', None)
    if not isinstance(root, Path):
        return None
    try:
        root_stamp = _file_stamp(root)
        if root_stamp is None or not stat.S_ISDIR(root_stamp[0]):
            return None
        stamps, found = [('avatars', root_stamp)], False
        for suffix in ('.png', '.jpg', '.webp'):
            path = root / (image_id + suffix)
            stamp = _file_stamp(path)
            if stamp is not None:
                if not stat.S_ISREG(stamp[0]) or not 0 < stamp[3] <= 3 * 1024 * 1024:
                    return None
                found = True
            stamps.append((suffix, stamp))
        if not found:
            return None
        material_root = plugin / 'assets/holo'
        pending = [(material_root, 0)]
        count = 0
        while pending:
            path, depth = pending.pop()
            stamp = _file_stamp(path)
            relative = path.relative_to(material_root).as_posix()
            stamps.append(('holo/' + relative, stamp))
            count += 1
            if count > ASSET_STAT_ENTRIES or depth > ASSET_STAT_DEPTH:
                return None
            if stamp is not None and stat.S_ISDIR(stamp[0]):
                children = sorted(path.iterdir(), key=lambda child: child.name)
                if len(children) + count > ASSET_STAT_ENTRIES:
                    return None
                pending.extend((child, depth + 1) for child in reversed(children))
        return hashlib.sha256(json.dumps(stamps, sort_keys=True).encode('utf-8')).hexdigest()
    except (OSError, ValueError):
        return None


def cacheable_avatar(avatar, image_id):
    module = registry_module()
    try:
        raw, _ = module._decode_avatar(avatar)
        return hashlib.sha256(raw).hexdigest() == image_id
    except (module.ValidationError, TypeError, ValueError):
        return False


def evaluate(connection, expression):
    response = connection.call('Runtime.evaluate', {'expression': expression, 'returnByValue': True,
        'awaitPromise': True, 'timeout': 10000, 'includeCommandLineAPI': False})
    if response.get('exceptionDetails'):
        raise RuntimeError('page-evaluation-failed')
    result = response.get('result', {}).get('value')
    if not isinstance(result, dict):
        raise RuntimeError('invalid-own-controller-result')
    return result


def own_call(body, expected_url=MAIN_URL):
    return f'''(() => {{if(location.href!=={json.dumps(expected_url)})return {{kind:'absent'}};
      const api=window.{API};if(!api)return {{kind:'absent'}};
      if(api.brand!=={json.dumps(BRAND)})throw new Error('own global conflict');
      {body}}})()'''


class BadgeSession:
    def __init__(self, registry, scope, renderer, revision, font_data='', probe=None, sidebar_project_title=''):
        self.registry, self.scope = registry, scope
        self.renderer, self.revision, self.font_data = renderer, revision, font_data
        self.probe = (PLUGIN / 'loader/probe.js').read_text(encoding='utf-8') if probe is None else probe
        self.retry_requested = False
        self.applied = None
        self.hidden = None
        self.font_sent = False
        self.saved_preferences = None
        self.recorded_context = None
        self.context_recorded_at = None
        self.asset_cache = OrderedDict()
        self.asset_cache_bytes = 0
        self.sent_assets = OrderedDict()
        build = re.search(r"const BUILD = '([^']+)'", renderer)
        self.expected_build = build.group(1) if build else None
        revision_match = re.search(r"const REVISION = '([^']+)'", renderer)
        self.expected_revision = revision_match.group(1) if revision_match else None
        self.sidebar_applied = None
        self.sidebar_summary = None
        self.runtime_build = None
        self.sidebar_project_title = sidebar_project_title
        self.cached_snapshot = None
        self.snapshot_checked_at = None
        self.snapshot_marker = None
        self.observed_context = None
        self.asset_signatures = OrderedDict()
        self.sidebar_marker_source = None
        self.sidebar_marker_value = None
        self.sidebar_assets = OrderedDict()
        self.sidebar_asset_bytes = 0
        self.diagnostics = {'probes': 0, 'snapshotReads': 0, 'versionChecks': 0,
                            'assetTreeChecks': 0, 'assetSignatureCacheHits': 0}

    def connection_changed(self):
        """Reconcile once per new page connection, including an existing own API."""
        self.applied, self.hidden, self.font_sent = None, None, False
        self.recorded_context, self.context_recorded_at = None, None
        self.sent_assets.clear()
        self.sidebar_applied = None
        self.cached_snapshot = None
        self.snapshot_checked_at = None
        self.snapshot_marker = None
        self.observed_context = None
        self.asset_signatures.clear()
        self.sidebar_marker_source = None

    def _registry_marker(self):
        """Read only the small metadata version, never materialize all profiles.

        The owned Registry already uses this version for optimistic updates. The
        periodic full refresh remains a fallback for simpler/offline adapters.
        """
        reader = getattr(self.registry, '_version', None)
        if callable(reader):
            with getattr(self.registry, '_lock', nullcontext()):
                self.diagnostics['versionChecks'] += 1
                return reader()
        value = getattr(self.registry, 'version', None)
        return value if type(value) is int else None

    def _snapshot_at(self, now, force=False):
        marker = self._registry_marker()
        if (self.cached_snapshot is None or force or marker != self.snapshot_marker
                or self.snapshot_checked_at is None
                or now - self.snapshot_checked_at >= REGISTRY_REFRESH_INTERVAL):
            snapshot = self.registry.snapshot()
            self.diagnostics['snapshotReads'] += 1
            self.cached_snapshot = snapshot
            self.snapshot_checked_at = now
            self.snapshot_marker = snapshot.get('version') if marker is not None else None
        return self.cached_snapshot

    def _read_asset_signature(self, image_id):
        self.diagnostics['assetTreeChecks'] += 1
        return asset_signature(self.registry, image_id)

    def _signature_at(self, image_id, role_marker, now, force=False):
        """Keep exhaustive material validation off the fast metadata probe.

        Avatar replacement/tampering is still detected by four cheap no-follow
        stamps on every probe. Full material-tree validation runs on selection,
        profile change, reconnection, or the bounded revalidation deadline.
        Packet creation retains its own second check to reject mid-read edits.
        """
        if not isinstance(image_id, str) or not IMAGE_ID.fullmatch(image_id):
            return None
        cache_id = (image_id, role_marker)
        root = getattr(self.registry, 'assets_dir', None)
        avatar_marker = None
        try:
            if isinstance(root, Path):
                avatar_marker = (_file_stamp(root), *(_file_stamp(root / (image_id + suffix))
                                                    for suffix in ('.png', '.jpg', '.webp')))
        except OSError:
            self.asset_signatures.pop(cache_id, None)
            return self._read_asset_signature(image_id)
        cached = self.asset_signatures.get(cache_id)
        if (not force and cached is not None and cached[1] == avatar_marker
                and cached[2] == role_marker and now - cached[3] < ASSET_REVALIDATION_INTERVAL):
            self.asset_signatures.move_to_end(cache_id)
            self.diagnostics['assetSignatureCacheHits'] += 1
            return cached[0]
        signature = self._read_asset_signature(image_id)
        # Uncertain/unsafe material sources are never memoized as valid assets.
        if signature is not None:
            self.asset_signatures[cache_id] = (signature, avatar_marker, role_marker, now)
            self.asset_signatures.move_to_end(cache_id)
            while len(self.asset_signatures) > ASSET_SIGNATURE_CACHE_ITEMS:
                self.asset_signatures.popitem(last=False)
        else:
            self.asset_signatures.pop(cache_id, None)
        return signature

    def _image_packet(self, image_id, signature):
        cache_id = (image_id, signature)
        if signature is not None and cache_id in self.asset_cache:
            packet, asset_key, _ = self.asset_cache[cache_id]
            self.asset_cache.move_to_end(cache_id)
            return packet, asset_key
        avatar = self.registry.avatar_data(image_id) if image_id else ''
        packet = {'avatarDataUrl': avatar}
        if avatar:
            layers = portrait_foreground(image_id)
            # The four planes already include cutout art: no duplicate legacy
            # foreground/contour in the transport packet.
            if layers.get('holoAssets'):
                packet['holoAssets'] = layers['holoAssets']
            else:
                packet.update({key: value for key, value in layers.items() if value})
        if (not avatar or signature is None or not cacheable_avatar(avatar, image_id)
                or self._read_asset_signature(image_id) != signature):
            return packet, None
        serialized = json.dumps(packet, sort_keys=True, separators=(',', ':')).encode('utf-8')
        asset_key = hashlib.sha256(serialized).hexdigest()
        size = len(serialized)
        if size <= ASSET_CACHE_BYTES:
            old = self.asset_cache.pop(cache_id, None)
            if old is not None:
                self.asset_cache_bytes -= old[2]
            self.asset_cache[cache_id] = (packet, asset_key, size)
            self.asset_cache_bytes += size
            while len(self.asset_cache) > ASSET_CACHE_ITEMS or self.asset_cache_bytes > ASSET_CACHE_BYTES:
                _, (_, _, removed_size) = self.asset_cache.popitem(last=False)
                self.asset_cache_bytes -= removed_size
        return packet, asset_key

    def _asset_sent(self, asset_key):
        self.sent_assets[asset_key] = None
        self.sent_assets.move_to_end(asset_key)
        while len(self.sent_assets) > ASSET_CACHE_ITEMS:
            self.sent_assets.popitem(last=False)

    def _save_runtime(self, runtime, snapshot):
        if not isinstance(runtime, dict):
            return
        known = {role.get('id') for role in snapshot.get('roles', []) if isinstance(role, dict)}
        role_id = runtime.get('roleId')
        if not isinstance(role_id, str) or role_id not in known or not isinstance(runtime.get('contextKey'), str):
            return
        layout, state = layout_only(runtime.get('layout')), card_state_only(runtime.get('cardState'))
        if layout or state:
            marker = (role_id, json.dumps([layout, state], sort_keys=True))
            if marker == self.saved_preferences:
                return
            self.registry.prefs_save(self.scope, role_id, layout, state)
            self.saved_preferences = marker

    def _record_context(self, context):
        # Title changes are reconciled on every fast probe. Seen-at heartbeats
        # need not write the same context four times a second.
        marker = (context['contextKey'], context['windowId'])
        now = time.monotonic()
        if (marker != self.recorded_context or self.context_recorded_at is None
                or now - self.context_recorded_at >= HEARTBEAT_INTERVAL):
            self.registry.record_context(context)
            self.recorded_context, self.context_recorded_at = marker, now

    def _define(self, connection):
        expression = f'''(() => {{if(location.href!=={json.dumps(MAIN_URL)})throw new Error('target changed');
          if(window.{API}&&window.{API}.brand!=={json.dumps(BRAND)})throw new Error('own global conflict');
          {self.renderer}\n;
          const api=window.{API};if(api?.brand!=={json.dumps(BRAND)})throw new Error('runtime missing');
          return api.status();}})()'''
        self.font_sent = False
        self.sent_assets.clear()
        self.sidebar_applied = None
        return evaluate(connection, expression)

    def _sidebar_art(self, image_id, signature):
        cache_id = (image_id, signature)
        if signature is not None and cache_id in self.sidebar_assets:
            art, _ = self.sidebar_assets[cache_id]
            self.sidebar_assets.move_to_end(cache_id)
            return art
        if str(PLUGIN) not in sys.path:
            sys.path.insert(0, str(PLUGIN))
        from backend.sidebar_assets import sidebar_art
        art = sidebar_art(image_id, PLUGIN, self.registry)
        # A second no-follow check rejects edits during image loading. Invalid
        # or uncertain source bytes never enter the persistent art memo.
        if (signature is not None and art.get('characterDataUrl')
                and self._read_asset_signature(image_id) == signature):
            size = len(json.dumps(art, separators=(',', ':')).encode('utf-8'))
            if size <= ASSET_CACHE_BYTES:
                previous = self.sidebar_assets.pop(cache_id, None)
                if previous is not None:
                    self.sidebar_asset_bytes -= previous[1]
                self.sidebar_assets[cache_id] = (art, size)
                self.sidebar_asset_bytes += size
                while (len(self.sidebar_assets) > SIDEBAR_CACHE_ITEMS
                       or self.sidebar_asset_bytes > ASSET_CACHE_BYTES):
                    _, (_, removed) = self.sidebar_assets.popitem(last=False)
                    self.sidebar_asset_bytes -= removed
        return art

    def _sidebar_batches(self, items):
        # JSON escaping can enlarge metadata. Measure the actual UTF-8 packet,
        # reserving transport-envelope headroom under CDP's 8 MiB message cap.
        batches, current = [], []
        for item in items:
            candidate = {'items': current + [item], 'projectTitle': self.sidebar_project_title}
            if batches:
                candidate['append'] = True
            argument = json.dumps(candidate, ensure_ascii=True, separators=(',', ':'))
            if len(argument.encode('utf-8')) >= SIDEBAR_PACKET_BYTES:
                if not current:
                    raise ValueError('sidebar-item-too-large')
                batches.append(current)
                current = [item]
                argument = json.dumps({'items': current, 'projectTitle': self.sidebar_project_title,
                                       'append': True}, ensure_ascii=True, separators=(',', ':'))
                if len(argument.encode('utf-8')) >= SIDEBAR_PACKET_BYTES:
                    raise ValueError('sidebar-item-too-large')
            else:
                current.append(item)
        if current or not batches:
            batches.append(current)
        return batches

    def _sync_sidebar(self, connection, snapshot, runtime):
        self.runtime_build = runtime.get('build')
        self.sidebar_summary = runtime.get('sidebar')
        if runtime.get('sidebarVersion') != 1:
            return runtime
        bindings = snapshot.get('bindings')
        if not isinstance(bindings, list):
            return runtime
        enabled = {role.get('id') for role in snapshot.get('roles', [])
                   if isinstance(role, dict) and role.get('enabled')}
        bound = {binding.get('roleId') for binding in bindings
                 if isinstance(binding, dict) and binding.get('kind') in ('title', 'thread')
                 and isinstance(binding.get('key'), str) and binding['key']}
        roles = [role for role in snapshot.get('roles', [])
                 if isinstance(role, dict) and role.get('id') in enabled & bound]
        now = time.monotonic()
        image_ids = dict.fromkeys(role.get('imageId') for role in roles)
        signatures = {image_id: self._signature_at(image_id, 'sidebar', now) for image_id in image_ids}
        marker_source = (id(snapshot), self.sidebar_project_title, tuple(signatures.items()))
        if marker_source != self.sidebar_marker_source:
            metadata = [{key: role.get(key) for key in ('id', 'name', 'role', 'imageId', 'enabled')}
                        for role in roles]
            self.sidebar_marker_value = json.dumps([metadata, bindings, self.sidebar_project_title,
                                                    list(signatures.items())], sort_keys=True, ensure_ascii=True)
            self.sidebar_marker_source = marker_source
        marker = self.sidebar_marker_value
        if marker == self.sidebar_applied:
            return runtime
        if str(PLUGIN) not in sys.path:
            sys.path.insert(0, str(PLUGIN))
        from backend.sidebar_assets import sidebar_items
        items = sidebar_items(snapshot, PLUGIN, self.registry,
                              lambda image_id: self._sidebar_art(image_id, signatures.get(image_id)))
        for index, batch in enumerate(self._sidebar_batches(items)):
            packet = {'items': batch, 'projectTitle': self.sidebar_project_title}
            if index:
                packet['append'] = True
            argument = json.dumps(packet, ensure_ascii=True, separators=(',', ':'))
            result = evaluate(connection, own_call(f'return api.configureSidebar({argument});'))
            if result.get('failed'):
                raise RuntimeError('own-controller-failed')
            self.sidebar_summary = result.get('sidebar')
        # A partial send is never remembered as complete. The next attempt starts
        # with replacement again, so a lost connection cannot duplicate entries.
        self.sidebar_applied = marker
        return result

    def _hide(self, connection, runtime, context_key, reason):
        marker = (context_key, reason)
        if runtime is not None and (self.hidden != marker or runtime.get('mounted')):
            options = {'reason': reason}
            if context_key is not None:
                options['contextKey'] = context_key
            argument = json.dumps(options)
            evaluate(connection, own_call(f'api.hide({argument});return api.status();'))
        self.applied, self.hidden = None, marker
        return reason

    def step(self, connection, target):
        page = evaluate(connection, self.probe)
        self.diagnostics['probes'] += 1
        if page.get('kind') == 'conflict':
            raise RuntimeError('foreign-global-conflict')
        if page.get('url') != target['url'] or not main_url(page.get('url')):
            raise RuntimeError('target-page-changed')
        if not page.get('ready'):
            return 'waiting-page'
        runtime = page.get('runtime')
        if runtime is not None and not isinstance(runtime, dict):
            raise RuntimeError('invalid-own-controller-result')
        if runtime is not None and runtime.get('failed'):
            if not self.retry_requested:
                raise RuntimeError('own-controller-failed')
            evaluate(connection, own_call('api.uninstall();return {kind:"removed"};'))
            runtime = None
            self.retry_requested = False
        context = context_at(target, page)
        context_marker = (target['id'], context['contextKey'] if context else None)
        changed_context = context_marker != self.observed_context
        now = time.monotonic()
        snapshot = self._snapshot_at(now, force=changed_context)
        self.observed_context = context_marker
        self._save_runtime(runtime, snapshot)
        # Sidebars are independent of the currently open conversation. A normal,
        # unbound chat must still display the other explicitly bound employees.
        enabled = {r.get('id') for r in snapshot.get('roles', []) if isinstance(r, dict) and r.get('enabled')}
        bindings = snapshot.get('bindings')
        sidebar_needed = isinstance(bindings, list) and any(isinstance(b, dict) and b.get('roleId') in enabled for b in bindings)
        if runtime is not None and ((self.expected_build and runtime.get('build') != self.expected_build)
                or (self.expected_revision and runtime.get('revision') != self.expected_revision)):
            runtime = self._define(connection)
        elif runtime is None and sidebar_needed:
            runtime = self._define(connection)
        if runtime is not None:
            runtime = self._sync_sidebar(connection, snapshot, runtime)
        if context is None:
            self.retry_requested = False
            self.recorded_context, self.context_recorded_at = None, None
            return self._hide(connection, runtime, None, 'unknown-context')
        self._record_context(context)
        role = self.registry.resolve(context)
        if role is None:
            self.retry_requested = False
            return self._hide(connection, runtime, context['contextKey'], 'unbound')
        if not isinstance(role, dict) or not isinstance(role.get('id'), str) or not role['id']:
            raise ValueError('invalid-role-record')
        self.retry_requested = False
        if runtime is None:
            runtime = self._define(connection)
            runtime = self._sync_sidebar(connection, snapshot, runtime)
        role_id, context_key = role['id'], context['contextKey']
        matching = runtime.get('roleId') == role_id and runtime.get('contextKey') == context_key
        role_marker = json.dumps(role, sort_keys=True, ensure_ascii=True)
        signature = self._signature_at(role.get('imageId'), role_marker, now, force=changed_context)
        fingerprint = (context_key, role_marker, signature)
        # A closed card stays closed, but its restore target must receive profile
        # edits before the user clicks it. Reconcile changed data with api.show;
        # the renderer preserves dismissal for this exact context and role.
        if matching and runtime.get('dismissed') and not runtime.get('stale') and self.applied == fingerprint:
            return 'dismissed'
        if (matching and runtime.get('mounted') and not runtime.get('stale') and self.applied == fingerprint):
            return 'mounted'
        preferences = self.registry.prefs_get(self.scope)
        states = preferences.get('roles', {})
        state = card_state_only(states.get(role_id, {})) if isinstance(states, dict) else {}
        packet, asset_key = self._image_packet(role.get('imageId'), signature)
        cache_protocol = type(runtime.get('assetCacheVersion')) is int and runtime['assetCacheVersion'] == 1
        reference = cache_protocol and asset_key is not None and asset_key in self.sent_assets
        argument = {'role': role, 'layout': layout_only(preferences.get('layout')), 'cardState': {'flipped': state.get('flipped', False),
                    'collapsed': state.get('collapsed', False)}, 'contextKey': context_key}
        if cache_protocol and asset_key is not None:
            argument['assetKey'] = asset_key
        if not reference:
            argument.update(packet)
        if not self.font_sent:
            argument['fontDataUrl'] = self.font_data
        # The selected chat may change between probe and reconciliation. Check its
        # exact title again before showing; never flash the previous chat's role.
        guard = f'if(document.title!=={json.dumps(context["title"])})return {{stale:true}};'
        result = evaluate(connection, own_call(guard + f'return api.show({json.dumps(argument)});'))
        if result.get('assetCacheMiss'):
            if not reference:
                raise RuntimeError('own-controller-not-mounted')
            # A page-side LRU may evict independently. Retry only once, in this
            # step, and repeat the exact title guard before supplying pixels.
            self.sent_assets.pop(asset_key, None)
            argument.update(packet)
            result = evaluate(connection, own_call(guard + f'return api.show({json.dumps(argument)});'))
            if result.get('assetCacheMiss'):
                raise RuntimeError('own-controller-not-mounted')
        if result.get('stale'):
            self.applied = None
            return 'waiting-context'
        if result.get('failed'):
            raise RuntimeError('own-controller-failed')
        if (result.get('roleId') != role_id or result.get('contextKey') != context_key
                or not (result.get('mounted') or result.get('dismissed'))):
            raise RuntimeError('own-controller-not-mounted')
        self.applied, self.hidden, self.font_sent = fingerprint, None, True
        if cache_protocol and asset_key is not None:
            self._asset_sent(asset_key)
        self._save_runtime(result, snapshot)
        return 'dismissed' if result.get('dismissed') else 'mounted'

    def shutdown(self, connection):
        value = evaluate(connection, own_call('const state=api.status();api.uninstall();return state;'))
        self._save_runtime(value, self.registry.snapshot())


def registry_module():
    if str(PLUGIN) not in sys.path:
        sys.path.insert(0, str(PLUGIN))
    from backend import registry
    return registry


def new_registry(state_dir):
    module = registry_module()
    try:
        return module.Registry(state_dir, seed_dir=PLUGIN / 'assets')
    except (module.RegistryError, sqlite3.Error) as error:
        raise ValueError('本地工牌资料不可用，请检查管理页与资料目录。') from error


@contextmanager
def service_lock(state_dir):
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = state_dir / 'run.lock'
    if path.is_symlink():
        raise ValueError('run.lock 是符号链接，未使用。')
    with path.open('a') as stream:
        os.chmod(path, 0o600)
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def enroll(state_dir, port, ask=input):
    with service_lock(state_dir) as acquired:
        if not acquired:
            raise ValueError('加载器正在运行；请先用 control.py stop。')
        pages = candidates(fetch_targets(port=port))
        if not pages:
            raise ValueError('没有可用聊天主窗口；请先通过 MaiBadges 启动器打开应用。')
        print('请选择主窗口；这不是角色绑定，也不会读取聊天正文：')
        for index, page in enumerate(pages, 1):
            title = ''.join(char for char in page['title'] if char.isprintable())
            print(f'  {index}. {title[:120]}  [窗口 {page["id"][:16]}]')
        answer = ask('输入序号（直接回车取消）：').strip()
        if not answer:
            print('已取消。'); return 0
        if not answer.isdecimal() or not 1 <= int(answer) <= len(pages):
            raise ValueError('序号无效，未保存。')
        page = pages[int(answer) - 1]
        validate_target_endpoint(page, port)
        previous = read_json(state_dir / 'config.json', {})
        scope = previous.get('scope') if valid_scope(previous.get('scope')) else str(uuid.uuid4())
        atomic_json(state_dir / 'config.json', {'schema': 1, 'scope': scope, 'port': port,
            'target': {'url': MAIN_URL, 'preferredId': page['id'], 'titleHint': page['title'] or 'ChatGPT'}})
        (state_dir / 'failure.json').unlink(missing_ok=True)
        (state_dir / 'retry.request').unlink(missing_ok=True)
        print('主窗口已登记；首次将按完整标题识别聊天，需在工牌管理中明确绑定角色。')
        return 0


def watch(state_dir, port=9347, interval=PROBE_INTERVAL):
    if (type(interval) not in (int, float) or not math.isfinite(interval) or interval <= 0):
        raise ValueError('加载检查间隔必须是正数。')
    with service_lock(state_dir) as acquired:
        if not acquired:
            print('加载器已运行，本次不重复启动。'); return 0
        config = config_at(state_dir)
        if port != config['port']:
            raise ValueError('端口与已登记的窗口不同，请重新 enroll。')
        renderer, revision, font = runtime_at()
        registry = new_registry(state_dir)
        registry_errors = (registry_module().RegistryError, sqlite3.Error)
        try:
            session = BadgeSession(registry, config['scope'], renderer, revision, font,
                                   sidebar_project_title=config.get('sidebarProjectTitle',''))
        except BaseException:
            registry.close()
            raise
        stop = threading.Event()
        previous_signals = {}
        connection, target_id, target, last_state = None, None, None, None
        next_discovery, status_written_at = 0.0, None
        stop_file = state_dir / 'stop.request'
        stop_file.unlink(missing_ok=True)

        def status(code):
            nonlocal last_state, status_written_at
            now = time.monotonic()
            if (code == last_state and status_written_at is not None
                    and now - status_written_at < HEARTBEAT_INTERVAL):
                return
            atomic_json(state_dir / 'status.json', {'service': SERVICE, 'state': code,
                'updatedAt': time.time(), 'intervalSeconds': interval,
                'discoveryIntervalSeconds': DISCOVERY_INTERVAL, 'contextMode': 'exact-title',
                'runtimeBuild': session.runtime_build, 'sidebar': session.sidebar_summary,
                'loaderDiagnostics': dict(session.diagnostics)})
            status_written_at = now
            if code != last_state:
                print(time.strftime('%Y-%m-%d %H:%M:%S'), code, flush=True); last_state = code

        try:
            for name in ('SIGTERM', 'SIGINT'):
                number = getattr(signal, name)
                previous_signals[number] = signal.signal(number, lambda *_: stop.set())
            while not stop.is_set() and not stop_file.exists():
                if (state_dir / 'failure.json').exists():
                    status('blocked-review-required'); stop.wait(DISCOVERY_INTERVAL); continue
                session.retry_requested = session.retry_requested or (state_dir / 'retry.request').exists()
                was_connected = connection is not None
                try:
                    # Keep the selected connection warm. Discovery is slower
                    # than metadata probing and does not need four HTTP calls
                    # per second; any lost connection forces a fresh lookup.
                    if connection is None or time.monotonic() >= next_discovery:
                        target = select_target(fetch_targets(port=port), config['target'])
                        next_discovery = time.monotonic() + DISCOVERY_INTERVAL
                    if target is None:
                        if connection: connection.close()
                        connection, target_id = None, None
                        status('waiting-main-window')
                    else:
                        if connection is None or target_id != target['id']:
                            if connection: connection.close()
                            connection = CDPConnection(validate_target_endpoint(target, port), port=port, timeout=12)
                            connection.__enter__(); target_id = target['id']
                            session.connection_changed()
                        status(session.step(connection, target))
                except registry_errors:
                    if connection: connection.close()
                    connection, target_id = None, None
                    status('waiting-registry')
                except ValueError as error:
                    if connection: connection.close()
                    connection, target_id = None, None
                    status('choose-window-again' if str(error) == 'multiple-main-windows' else 'invalid-configuration-or-endpoint')
                except (OSError, TimeoutError):
                    if connection: connection.close()
                    connection, target_id = None, None
                    status('waiting-debug-port')
                except RuntimeError as error:
                    if connection: connection.close()
                    connection, target_id = None, None
                    if str(error) in BLOCKED_ERRORS:
                        atomic_json(state_dir / 'failure.json', {'service': SERVICE, 'reason': str(error),
                            'instruction': '先排查错误；确认后手动运行 main.py retry。'})
                        status('blocked-review-required')
                    else:
                        status('page-or-protocol-error')
                if not session.retry_requested:
                    (state_dir / 'retry.request').unlink(missing_ok=True)
                # A connection lost during this round gets one prompt lookup.
                # While the application is absent, retain the slower backoff.
                stop.wait(interval if connection is not None or was_connected else DISCOVERY_INTERVAL)
        finally:
            try:
                if connection:
                    try: session.shutdown(connection)
                    except (OSError, RuntimeError, ValueError): pass
                    finally: connection.close()
                status('stopped')
                stop_file.unlink(missing_ok=True)
            finally:
                try:
                    registry.close()
                finally:
                    for number, handler in previous_signals.items():
                        signal.signal(number, handler)
        return 0


def cli(argv=None):
    parser = argparse.ArgumentParser(description='MaiBadges 工牌加载器；仅显式 enroll/watch 连接本机调试入口。')
    parser.add_argument('command', choices=('enroll', 'watch', 'status', 'retry'))
    parser.add_argument('--state-dir', type=Path, default=DEFAULT_STATE)
    parser.add_argument('--port', type=int, default=9347)
    args = parser.parse_args(argv)
    if not 1024 <= args.port <= 65535:
        parser.error('端口范围必须是 1024–65535。')
    state_dir = args.state_dir.expanduser().resolve()
    try:
        if args.command == 'status':
            print(json.dumps(read_json(state_dir / 'status.json', {'state': 'not-started'}), ensure_ascii=False, indent=2)); return 0
        if args.command == 'retry':
            atomic_json(state_dir / 'retry.request', {'service': SERVICE, 'requestedAt': time.time()})
            (state_dir / 'failure.json').unlink(missing_ok=True)
            print('已解除本加载器的暂停；正在运行的服务将重新检查。'); return 0
        if args.command == 'enroll':
            return enroll(state_dir, args.port)
        return watch(state_dir, args.port)
    except (OSError, ValueError, RuntimeError) as error:
        print('未完成：' + (str(error)[:200] if isinstance(error, ValueError) else '本地文件或调试连接不可用。'), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(cli())
