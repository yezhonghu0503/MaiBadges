"""Offline loader contracts: memory registries/transports and project-local files."""
import contextlib
import copy
import errno
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'loader'))
SPEC = importlib.util.spec_from_file_location('work_badges_loader_contract', ROOT / 'loader/main.py')
loader = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(loader)
SCOPE = '86c36ad8-3e65-4efb-a523-13ab3882e2b8'
MILO = {'id': 'milo', 'name': 'Milo', 'role': '互动运营', 'duties': [], 'imageId': 'a' * 64, 'enabled': True, 'bio': '互动运营'}
MAXIE = {'id': 'maxie', 'name': 'Maxie', 'role': '资深分析师', 'duties': [], 'imageId': 'b' * 64, 'enabled': True, 'bio': '分析'}
TITLE = 'Milo（互动运营）'
OTHER_TITLE = 'Maxie（资深分析师）'
TINY_PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==')


def show_argument(call):
    expression = call[1]['expression']
    start = expression.index('api.show(') + len('api.show(')
    return json.JSONDecoder().raw_decode(expression[start:])[0]


def page(identifier='one', title=TITLE, url=loader.MAIN_URL):
    return {'id': identifier, 'title': title, 'url': url, 'type': 'page',
            'webSocketDebuggerUrl': f'ws://127.0.0.1:9347/devtools/page/{identifier}'}


def runtime(role='milo', title=TITLE, **changes):
    state = {'mounted': True, 'roleId': role, 'contextKey': 'title:' + title,
             'layout': {'x': 40, 'y': 70, 'width': 266},
             'cardState': {'flipped': False, 'collapsed': False},
             'dismissed': False, 'failed': False, 'stale': False}
    state.update(changes)
    return state


def result(value):
    return {'result': {'value': value}}


def probe(title=TITLE, current=None, **changes):
    value = {'url': loader.MAIN_URL, 'title': title, 'ready': True, 'runtime': current}
    value.update(changes)
    return result(value)


class Connection:
    def __init__(self, results):
        self.results, self.calls, self.closed = list(results), [], False

    def call(self, method, params):
        self.calls.append((method, params))
        if not self.results:
            raise RuntimeError('unexpected-mock-call')
        value = self.results.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value

    def __enter__(self):
        return self

    def close(self):
        self.closed = True


class Registry:
    def __init__(self):
        self.version = 1
        self.roles = {'milo': copy.deepcopy(MILO), 'maxie': copy.deepcopy(MAXIE)}
        self.bindings = {'title:' + TITLE: 'milo', 'title:' + OTHER_TITLE: 'maxie'}
        self.contexts, self.saved, self.avatar_reads = [], [], []
        self.preferences = {}
        self.closed = False

    def close(self):
        self.closed = True

    def snapshot(self):
        return {'version': self.version, 'roles': copy.deepcopy(list(self.roles.values())),
                'bindings': dict(self.bindings), 'contexts': copy.deepcopy(self.contexts)}

    def record_context(self, context):
        self.contexts.append(copy.deepcopy(context))

    def resolve(self, context):
        role = self.roles.get(self.bindings.get(context['contextKey']))
        return copy.deepcopy(role) if role and role.get('enabled') else None

    def avatar_data(self, image_id):
        self.avatar_reads.append(image_id)
        return 'data:image/png;base64,AA=='

    def prefs_get(self, scope):
        return copy.deepcopy(self.preferences.get(scope, {'layout': {}, 'roles': {}}))

    def prefs_save(self, scope, role_id, layout, card_state):
        self.saved.append((scope, role_id, copy.deepcopy(layout), copy.deepcopy(card_state)))
        state = self.preferences.setdefault(scope, {'layout': {}, 'roles': {}})
        state['layout'].update(layout)
        state['roles'].setdefault(role_id, {}).update(card_state)


class Pulse:
    def __init__(self, rounds, elapsed_per_wait=None):
        self.rounds, self.done = rounds, False
        self.now, self.waits, self.elapsed_per_wait = 0.0, [], elapsed_per_wait

    def is_set(self):
        return self.done

    def set(self):
        self.done = True

    def wait(self, duration):
        self.waits.append(duration)
        self.now += duration if self.elapsed_per_wait is None else self.elapsed_per_wait
        self.rounds -= 1
        self.done = self.rounds <= 0


class NodeMemoryConnection:
    """Run the real renderer against the renderer suite's DOM model, not a browser.

    JSON lines travel over pipes to an owned Node test subprocess. No socket,
    debugging endpoint, native app, or production controller is involved.
    """
    def __init__(self):
        helper = (ROOT / 'tests/check-renderer.mjs').read_text()
        start, end = helper.index('function environment(options={}){'), helper.index('\nfunction profile(')
        script = '''import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import readline from 'node:readline';
const source=readFileSync('./runtime/renderer.js','utf8');
''' + helper[start:end] + '''
const env=environment();
env.document.readyState='complete';env.document.title='Milo（互动运营）';
env.context.location={href:'app://-/index.html'};
env.window.MaiWorkBadgeRuntime.uninstall();
const input=readline.createInterface({input:process.stdin});
function output(value){process.stdout.write(JSON.stringify(value)+'\\n');}
output({ready:true});
input.on('line',line=>{
  try {
    const command=JSON.parse(line);
    if(command.op==='quit'){input.close();process.exit(0);}
    if(command.op==='evaluate'){
      try {output({result:{value:vm.runInContext(command.expression,env.context)}});}
      catch {output({exceptionDetails:{description:'mock-page-exception'}});}
      return;
    }
    if(command.op==='content'){output({text:env.root()?.textContent??''});return;}
    if(command.op==='imagesReady')for(const image of env.root()?.querySelectorAll('img')??[]){image.complete=true;image.naturalWidth=1;image.dispatchEvent({type:'load'});}
    if(command.op==='title')env.document.title=command.value;
    if(command.op==='close')env.root().querySelectorAll('.close').find(button=>!button.disabled).dispatchEvent({type:'click',bubbles:true});
    if(command.op==='restore')env.root().querySelector('.restore').dispatchEvent({type:'click',bubbles:true});
    if(command.op==='flip')env.root().querySelector('.front').dispatchEvent({type:'click',bubbles:true});
    env.flushFrames();output(env.window.MaiWorkBadgeRuntime?.status()??{absent:true});
  }catch(error){output({fatal:String(error.message)});}
});
'''
        self.process = subprocess.Popen([shutil.which('node'), '--input-type=module', '-e', script],
                                        cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True)
        self.calls = []
        if not self._read().get('ready'):
            raise RuntimeError('Memory renderer did not initialize')

    def _read(self):
        if not select.select([self.process.stdout], [], [], 8)[0]:
            raise RuntimeError('Memory renderer timed out')
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError('Memory renderer ended: ' + self.process.stderr.read()[:600])
        value = json.loads(line)
        if 'fatal' in value:
            raise RuntimeError(value['fatal'])
        return value

    def command(self, op, **arguments):
        self.process.stdin.write(json.dumps({'op': op, **arguments}) + '\n')
        self.process.stdin.flush()
        return self._read()

    def call(self, method, params):
        if method != 'Runtime.evaluate':
            raise AssertionError('Only an in-memory Runtime.evaluate is supported')
        self.calls.append((method, params))
        return self.command('evaluate', expression=params['expression'])

    def close(self):
        try:
            if self.process.poll() is None:
                self.process.stdin.write('{"op":"quit"}\n'); self.process.stdin.flush()
                try:
                    self.process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    # Only our own Node fixture process can be terminated here.
                    self.process.terminate(); self.process.wait(timeout=8)
        finally:
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                stream.close()


class LoaderContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_base = Path(__file__).resolve().parent / '.tmp'
        cls.temp_base.mkdir(exist_ok=True)
        cls.temp_parent = Path(tempfile.mkdtemp(prefix='loader-suite-', dir=cls.temp_base))

    @classmethod
    def tearDownClass(cls):
        cls.temp_parent.rmdir()
        try:
            cls.temp_base.rmdir()
        except OSError as error:
            if error.errno not in (errno.ENOTEMPTY, errno.EEXIST, errno.ENOENT):
                raise

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='loader-', dir=self.temp_parent)
        self.addCleanup(temporary.cleanup)
        self.state = Path(temporary.name)
        self.registry = Registry()
        self.selection = {'url': loader.MAIN_URL, 'preferredId': 'one', 'titleHint': TITLE}
        self.patches = contextlib.ExitStack()
        self.addCleanup(self.patches.close)
        # Any accidentally unmocked transport path fails without opening sockets.
        self.patches.enter_context(mock.patch.object(loader, 'fetch_targets', side_effect=AssertionError('No real discovery')))
        self.patches.enter_context(mock.patch.object(loader, 'CDPConnection', side_effect=AssertionError('No real CDP connection')))

    def session(self):
        return loader.BadgeSession(self.registry, SCOPE, '/* mock renderer */', 'revision', 'data:font/ttf;base64,AA==')

    def cached_assets(self):
        """Source metadata and image reads are project-local test fixtures."""
        self.registry.assets_dir = self.state / 'avatar-fixtures'
        self.registry.assets_dir.mkdir()
        plugin = self.state / 'plugin-fixtures'
        (plugin / 'assets/holo/test').mkdir(parents=True)
        self.layer_file = plugin / 'assets/holo/test/background.png'
        self.layer_file.write_bytes(TINY_PNG)
        (plugin / 'assets/holo/test/manifest.json').write_text('{}')
        original_signature = loader.asset_signature
        self.patches.enter_context(mock.patch.object(loader, 'asset_signature',
            side_effect=lambda registry, image_id: original_signature(registry, image_id, plugin)))
        def avatar_data(image_id):
            self.registry.avatar_reads.append(image_id)
            path = self.registry.assets_dir / (image_id + '.png')
            try:
                raw = path.read_bytes()
            except OSError:
                return ''
            return ('data:image/png;base64,' + base64.b64encode(raw).decode('ascii')
                    if hashlib.sha256(raw).hexdigest() == image_id else '')
        self.registry.avatar_data = avatar_data
        return plugin

    def avatar_fixture(self, index=0, role_id=None):
        raw = TINY_PNG + bytes([index])
        image_id = hashlib.sha256(raw).hexdigest()
        (self.registry.assets_dir / (image_id + '.png')).write_bytes(raw)
        if role_id:
            self.registry.roles[role_id]['imageId'] = image_id
        return image_id

    def config(self):
        loader.atomic_json(self.state / 'config.json', {'schema': 1, 'scope': SCOPE, 'port': 9347, 'target': self.selection})

    def test_import_has_no_app_or_file_actions(self):
        with mock.patch.object(Path, 'mkdir', side_effect=AssertionError('No import writes')), \
             mock.patch.object(loader, 'fetch_targets', side_effect=AssertionError('No import discovery')):
            spec = importlib.util.spec_from_file_location('work_badges_loader_import_only', ROOT / 'loader/main.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        self.assertEqual(module.DEFAULT_STATE.name, 'MaiBadges')

    def test_only_exact_main_surfaces_are_candidates(self):
        targets = [page(), page('avatar', url=loader.MAIN_URL + '?initialRoute=/avatar-overlay'),
                   page('web', url='https://chatgpt.com/'), page('detached', url='app://-/detached-window.html'),
                   {**page('worker'), 'type': 'worker'}]
        self.assertEqual([item['id'] for item in loader.candidates(targets)], ['one'])
        self.assertEqual(loader.candidates([page(), page()]), [page()])
        with self.assertRaises(ValueError):
            loader.candidates([page(), page(title='different')])

    def test_target_selection_restarts_with_new_id_and_fails_on_ambiguity(self):
        self.assertEqual(loader.select_target([page('new')], self.selection)['id'], 'new')
        self.assertIsNone(loader.select_target([], self.selection))
        with self.assertRaisesRegex(ValueError, 'multiple-main-windows'):
            loader.select_target([page('new'), page('newer')], self.selection)
        with self.assertRaises(ValueError):
            loader.validate_target_endpoint({**page(), 'webSocketDebuggerUrl': 'ws://127.0.0.1:9347/devtools/page/other'}, 9347)

    def test_context_is_exact_title_metadata_never_a_target_id_disguised_as_chat_id(self):
        context = loader.context_at(page('window-123'), {'title': '  A / Exact Title  '}, now=42)
        self.assertEqual(context['contextKey'], 'title:  A / Exact Title  ')
        self.assertIsNone(context['threadKey'])
        self.assertEqual(context['windowId'], 'window-123')
        self.assertEqual(set(context), {'windowId', 'title', 'threadKey', 'contextKey', 'seenAt', 'url'})
        for title in ('', ' ', 'ChatGPT', ' codex ', 'OPENAI', None):
            self.assertIsNone(loader.context_at(page(), {'title': title}))

    def test_probe_only_reads_title_url_and_own_runtime(self):
        probe_source = (ROOT / 'loader/probe.js').read_text()
        self.assertIn('document.title', probe_source)
        self.assertIn('MaiWorkBadgeRuntime', probe_source)
        for forbidden in ('querySelector', 'innerText', 'textContent', 'innerHTML'):
            self.assertNotIn(forbidden, probe_source)

    def test_new_bound_context_defines_then_shows_only_resolved_role(self):
        connection = Connection([probe(), result({'mounted': False}), result(runtime())])
        self.assertEqual(self.session().step(connection, page()), 'mounted')
        self.assertEqual(len(connection.calls), 3)
        expression = connection.calls[2][1]['expression']
        self.assertIn('api.show(', expression)
        self.assertIn('"id": "milo"', expression)
        self.assertIn('"contextKey": "title:', expression)
        self.assertIn('data:font/ttf;base64,AA==', expression)
        self.assertEqual(self.registry.contexts[0]['title'], TITLE)
        self.assertEqual(self.registry.avatar_reads, [MILO['imageId']])

    def test_same_bound_context_polls_without_rebuilding_and_saves_latest_position(self):
        session = self.session()
        current = runtime()
        moved = runtime(layout={'x': 90, 'y': 120, 'width': 280})
        connection = Connection([probe(current=current), result(current), probe(current=moved)])
        self.assertEqual(session.step(connection, page()), 'mounted')
        self.assertEqual(session.step(connection, page()), 'mounted')
        self.assertEqual(len(connection.calls), 3)
        self.assertEqual(self.registry.prefs_get(SCOPE)['layout']['x'], 90)

    def test_fast_probe_keeps_context_and_preferences_writes_at_their_own_cadence(self):
        session = self.session()
        now = [0.0]
        connection = Connection([probe(current=runtime()), result(runtime()),
                                 probe(current=runtime()), probe(current=runtime()), probe(current=runtime())])
        with mock.patch.object(loader.time, 'monotonic', side_effect=lambda: now[0]):
            self.assertEqual(session.step(connection, page()), 'mounted')
            now[0] = .25
            self.assertEqual(session.step(connection, page()), 'mounted')
            now[0] = 1.99
            self.assertEqual(session.step(connection, page()), 'mounted')
            self.assertEqual(len(self.registry.contexts), 1)
            now[0] = 2
            self.assertEqual(session.step(connection, page()), 'mounted')
        self.assertEqual(len(self.registry.contexts), 2)
        self.assertEqual(len(self.registry.saved), 1)
        self.assertEqual(self.registry.avatar_reads, [MILO['imageId']])

    def test_context_switch_and_return_are_recorded_without_waiting_for_heartbeat(self):
        session = self.session()
        connection = Connection([probe(current=runtime()), result(runtime()),
                                 probe(OTHER_TITLE, runtime(stale=True)), result(runtime('maxie', OTHER_TITLE)),
                                 probe('ChatGPT', runtime('maxie', OTHER_TITLE)), result({'mounted': False}),
                                 probe(OTHER_TITLE, runtime('maxie', OTHER_TITLE, stale=True)),
                                 result(runtime('maxie', OTHER_TITLE))])
        with mock.patch.object(loader.time, 'monotonic', return_value=0):
            self.assertEqual(session.step(connection, page()), 'mounted')
            self.assertEqual(session.step(connection, page()), 'mounted')
            self.assertEqual(session.step(connection, page()), 'unknown-context')
            self.assertEqual(session.step(connection, page()), 'mounted')
        self.assertEqual([context['title'] for context in self.registry.contexts], [TITLE, OTHER_TITLE, OTHER_TITLE])

    def test_preferences_save_changes_and_role_transitions_but_skip_identical_state(self):
        session = self.session()
        snapshot = self.registry.snapshot()
        session._save_runtime(runtime(), snapshot)
        session._save_runtime(runtime(), snapshot)
        session._save_runtime(runtime(layout={'x': 80}), snapshot)
        session._save_runtime(runtime('maxie', OTHER_TITLE, layout={'x': 80}), snapshot)
        session._save_runtime(runtime(layout={'x': 40}), snapshot)
        self.assertEqual(len(self.registry.saved), 4)
        self.assertEqual(self.registry.prefs_get(SCOPE)['layout']['x'], 40)

    def test_connection_change_reconciles_existing_own_api_and_resends_font_once(self):
        session = self.session()
        first = Connection([probe(current=runtime()), result(runtime()), probe(current=runtime())])
        self.assertEqual(session.step(first, page()), 'mounted')
        self.assertTrue(session.font_sent)
        self.assertEqual(session.step(first, page()), 'mounted')
        self.assertEqual(len(first.calls), 3)
        session.connection_changed()
        self.assertFalse(session.font_sent)
        second = Connection([probe(current=runtime()), result(runtime()), probe(current=runtime())])
        self.assertEqual(session.step(second, page('new')), 'mounted')
        self.assertIn('"fontDataUrl": "data:font/ttf;base64,AA=="', second.calls[1][1]['expression'])
        self.assertEqual(session.step(second, page('new')), 'mounted')
        self.assertEqual(len(second.calls), 3)

    def test_switching_exact_titles_switches_roles_and_restores_each_roles_state(self):
        self.registry.preferences[SCOPE] = {'layout': {'x': 50, 'y': 60, 'width': 266},
                                           'roles': {'maxie': {'flipped': True, 'collapsed': True}}}
        old = runtime(cardState={'flipped': False, 'collapsed': False}, stale=True, mounted=False)
        target = runtime(role='maxie', title=OTHER_TITLE, cardState={'flipped': True, 'collapsed': True})
        connection = Connection([probe(OTHER_TITLE, old), result(target)])
        self.assertEqual(self.session().step(connection, page()), 'mounted')
        expression = connection.calls[-1][1]['expression']
        self.assertIn('"id": "maxie"', expression)
        self.assertIn('"flipped": true, "collapsed": true', expression)
        self.assertNotIn('"id": "milo"', expression)
        self.assertEqual(self.registry.prefs_get(SCOPE)['roles']['milo']['flipped'], False)

    def test_unbound_or_disabled_role_hides_old_card_without_defaulting_to_milo(self):
        for title in ('Unbound conversation', TITLE):
            if title == TITLE:
                self.registry.roles['milo']['enabled'] = False
            connection = Connection([probe(title, runtime()), result({'mounted': False})])
            self.assertEqual(self.session().step(connection, page()), 'unbound')
            self.assertEqual(len(connection.calls), 2)
            self.assertIn('api.hide(', connection.calls[1][1]['expression'])
            self.assertNotIn('api.show(', connection.calls[1][1]['expression'])

    def test_generic_title_hides_without_recording_a_bindable_context(self):
        connection = Connection([probe('ChatGPT', runtime()), result({'mounted': False})])
        self.assertEqual(self.session().step(connection, page()), 'unknown-context')
        self.assertEqual(self.registry.contexts, [])
        self.assertIn('unknown-context', connection.calls[-1][1]['expression'])
        self.assertNotIn('"contextKey": null', connection.calls[-1][1]['expression'])

    def test_dismissed_profile_edits_refresh_restore_data_without_opening_the_card(self):
        session = self.session()
        connection = Connection([probe(current=runtime()), result(runtime()),
                                 probe(current=runtime(mounted=False, dismissed=True)),
                                 result(runtime(mounted=False, dismissed=True)),
                                 probe(current=runtime(mounted=False, dismissed=True))])
        self.assertEqual(session.step(connection, page()), 'mounted')
        self.registry.roles['milo']['bio'] = 'edited'
        self.assertEqual(session.step(connection, page()), 'dismissed')
        self.assertIn('"bio": "edited"', connection.calls[-1][1]['expression'])
        self.assertIn('api.show(', connection.calls[-1][1]['expression'])
        self.assertEqual(session.step(connection, page()), 'dismissed')
        self.assertEqual(len(connection.calls), 5)

    def test_returning_to_a_previously_dismissed_role_is_a_valid_hidden_result(self):
        session = self.session()
        connection = Connection([probe(current=runtime(role='maxie')),
                                 result(runtime(mounted=False, dismissed=True)),
                                 probe(current=runtime(mounted=False, dismissed=True))])
        self.assertEqual(session.step(connection, page()), 'dismissed')
        self.assertEqual(session.step(connection, page()), 'dismissed')
        self.assertEqual(len(connection.calls), 3)
        # Dismissal only authorizes the requested role and exact context.
        wrong = Connection([probe(current=runtime(role='maxie')),
                            result(runtime(role='maxie', mounted=False, dismissed=True))])
        with self.assertRaisesRegex(RuntimeError, '^own-controller-not-mounted$'):
            self.session().step(wrong, page())

    def test_profile_edit_updates_without_reinstalling_runtime(self):
        session = self.session()
        connection = Connection([probe(current=runtime()), result(runtime()), probe(current=runtime()), result(runtime())])
        session.step(connection, page())
        self.registry.roles['milo']['bio'] = 'new responsibilities'
        self.registry.version += 1
        session.step(connection, page())
        self.assertIn('new responsibilities', connection.calls[-1][1]['expression'])
        self.assertEqual(sum('mock renderer' in params['expression'] for _, params in connection.calls), 0)

    def test_cached_chat_return_only_sends_asset_reference_and_keeps_roles_current(self):
        self.cached_assets()
        milo_id = self.avatar_fixture(1, 'milo')
        maxie_id = self.avatar_fixture(2, 'maxie')
        session = self.session()
        first = runtime(assetCacheVersion=1)
        second = runtime('maxie', OTHER_TITLE, assetCacheVersion=1)
        connection = Connection([probe(current=first), result(first),
                                 probe(OTHER_TITLE, first), result(second),
                                 probe(TITLE, second), result(first)])
        with mock.patch.object(loader, 'portrait_foreground', return_value={}) as layers:
            self.assertEqual(session.step(connection, page()), 'mounted')
            self.assertEqual(session.step(connection, page()), 'mounted')
            self.registry.roles['milo']['bio'] = 'newest profile text'
            self.assertEqual(session.step(connection, page()), 'mounted')
        full, other, warm = (show_argument(connection.calls[index]) for index in (1, 3, 5))
        self.assertIn('avatarDataUrl', full)
        self.assertIn('avatarDataUrl', other)
        self.assertNotIn('avatarDataUrl', warm)
        self.assertEqual(warm['assetKey'], full['assetKey'])
        self.assertNotEqual(warm['assetKey'], other['assetKey'])
        self.assertEqual(warm['role']['id'], 'milo')
        self.assertEqual(warm['role']['bio'], 'newest profile text')
        self.assertEqual(self.registry.avatar_reads, [milo_id, maxie_id])
        self.assertEqual(layers.call_count, 2)
        self.assertLess(len(json.dumps(warm)), len(json.dumps(full)))

    def test_old_runtime_keeps_full_packets_while_local_asset_reads_are_cached(self):
        self.cached_assets()
        image_id = self.avatar_fixture(1, 'milo')
        session = self.session()
        connection = Connection([probe(current=runtime()), result(runtime()),
                                 probe(current=runtime()), result(runtime())])
        with mock.patch.object(loader, 'portrait_foreground', return_value={}):
            session.step(connection, page())
            self.registry.roles['milo']['bio'] = 'edited'
            session.step(connection, page())
        for index in (1, 3):
            argument = show_argument(connection.calls[index])
            self.assertIn('avatarDataUrl', argument)
            self.assertNotIn('assetKey', argument)
        self.assertEqual(self.registry.avatar_reads, [image_id])

    def test_page_cache_miss_retries_full_packet_once_with_the_same_title_guard(self):
        self.cached_assets()
        self.avatar_fixture(1, 'milo')
        session = self.session()
        current = runtime(assetCacheVersion=1)
        connection = Connection([probe(current=current), result(current), probe(current=current),
                                 result({'assetCacheMiss': True, 'assetCacheVersion': 1}), result(current)])
        with mock.patch.object(loader, 'portrait_foreground', return_value={}):
            session.step(connection, page())
            self.registry.roles['milo']['bio'] = 'edited'
            self.assertEqual(session.step(connection, page()), 'mounted')
        reference, retry = (show_argument(connection.calls[index]) for index in (3, 4))
        self.assertNotIn('avatarDataUrl', reference)
        self.assertIn('avatarDataUrl', retry)
        self.assertEqual(reference['assetKey'], retry['assetKey'])
        for index in (3, 4):
            self.assertIn('if(document.title!==', connection.calls[index][1]['expression'])
            self.assertIn('return api.show(', connection.calls[index][1]['expression'])
        self.assertEqual(len(self.registry.avatar_reads), 1)

    def test_repeated_page_cache_miss_blocks_without_an_unbounded_retry(self):
        self.cached_assets()
        self.avatar_fixture(1, 'milo')
        session = self.session()
        current = runtime(assetCacheVersion=1)
        connection = Connection([probe(current=current), result(current), probe(current=current),
                                 result({'assetCacheMiss': True}), result({'assetCacheMiss': True})])
        with mock.patch.object(loader, 'portrait_foreground', return_value={}):
            session.step(connection, page())
            self.registry.roles['milo']['bio'] = 'edited'
            with self.assertRaisesRegex(RuntimeError, '^own-controller-not-mounted$'):
                session.step(connection, page())
        self.assertEqual(len(connection.calls), 5)
        self.assertEqual(len(session.sent_assets), 0)

    def test_cache_miss_retry_rechecks_title_and_does_not_authorize_stale_result(self):
        self.cached_assets()
        self.avatar_fixture(1, 'milo')
        session = self.session()
        current = runtime(assetCacheVersion=1)
        connection = Connection([probe(current=current), result(current), probe(current=current),
                                 result({'assetCacheMiss': True}), result({'stale': True})])
        with mock.patch.object(loader, 'portrait_foreground', return_value={}):
            session.step(connection, page())
            self.registry.roles['milo']['bio'] = 'edited'
            self.assertEqual(session.step(connection, page()), 'waiting-context')
        self.assertIsNone(session.applied)
        self.assertEqual(len(session.sent_assets), 0)

    def test_connection_change_and_define_clear_page_references_but_keep_local_packet(self):
        self.cached_assets()
        image_id = self.avatar_fixture(1, 'milo')
        session = self.session()
        current = runtime(assetCacheVersion=1)
        first = Connection([probe(current=current), result(current)])
        second = Connection([probe(current=current), result(current)])
        with mock.patch.object(loader, 'portrait_foreground', return_value={}):
            session.step(first, page())
            session.connection_changed()
            self.assertEqual(len(session.sent_assets), 0)
            session.step(second, page('new'))
            self.assertIn('avatarDataUrl', show_argument(second.calls[1]))
            self.assertIn('fontDataUrl', show_argument(second.calls[1]))
            session._define(Connection([result({'assetCacheVersion': 1})]))
        self.assertEqual(self.registry.avatar_reads, [image_id])
        self.assertEqual(len(session.sent_assets), 0)
        self.assertEqual(len(session.asset_cache), 1)

    def test_unbound_and_disabled_contexts_never_restore_cached_identity(self):
        for disabled in (False, True):
            with self.subTest(disabled=disabled):
                if not hasattr(self.registry, 'assets_dir'):
                    self.cached_assets()
                self.registry.roles['milo']['enabled'] = True
                self.registry.bindings['title:' + TITLE] = 'milo'
                self.avatar_fixture(1, 'milo')
                session = self.session()
                current = runtime(assetCacheVersion=1)
                connection = Connection([probe(current=current), result(current),
                                         probe(current=current), result({'mounted': False})])
                with mock.patch.object(loader, 'portrait_foreground', return_value={}):
                    session.step(connection, page())
                    if disabled:
                        self.registry.roles['milo']['enabled'] = False
                    else:
                        self.registry.bindings.pop('title:' + TITLE)
                    self.assertEqual(session.step(connection, page()), 'unbound')
                self.assertIn('api.hide(', connection.calls[-1][1]['expression'])
                self.assertNotIn('api.show(', connection.calls[-1][1]['expression'])

    def test_material_edits_invalidate_same_image_and_mounted_profile(self):
        self.cached_assets()
        self.avatar_fixture(1, 'milo')
        session = self.session()
        current = runtime(assetCacheVersion=1)
        connection = Connection([probe(current=current), result(current), probe(current=current),
                                 probe(current=current), result(current)])
        now = [0.0]
        first_url = 'data:image/png;base64,' + base64.b64encode(TINY_PNG).decode('ascii')
        second_url = 'data:image/png;base64,' + base64.b64encode(TINY_PNG + b'new').decode('ascii')
        layers = lambda url: {'holoAssets': {name: url for name in ('character', 'background', 'ui', 'structure')}}
        with mock.patch.object(loader, 'portrait_foreground', side_effect=[layers(first_url), layers(second_url)]), \
             mock.patch.object(loader.time, 'monotonic', side_effect=lambda: now[0]):
            session.step(connection, page())
            old = self.layer_file.stat()
            self.layer_file.write_bytes(TINY_PNG[:-1] + b'x')
            os.utime(self.layer_file, ns=(old.st_atime_ns, old.st_mtime_ns))
            # Material checks are independent of the fast context probe. The
            # same mounted identity stays cached until the bounded deadline.
            now[0] = loader.ASSET_REVALIDATION_INTERVAL - .01
            self.assertEqual(session.step(connection, page()), 'mounted')
            self.assertEqual(len(connection.calls), 3)
            now[0] = loader.ASSET_REVALIDATION_INTERVAL
            self.assertEqual(session.step(connection, page()), 'mounted')
        first, changed = (show_argument(connection.calls[index]) for index in (1, 4))
        self.assertNotEqual(first['assetKey'], changed['assetKey'])
        self.assertIn('holoAssets', changed)
        self.assertEqual(len(self.registry.avatar_reads), 2)

    def test_fast_idle_probes_do_not_repeat_full_snapshot_or_material_tree_scan(self):
        self.cached_assets()
        self.avatar_fixture(1, 'milo')
        session = self.session()
        current = runtime(assetCacheVersion=1)
        connection = Connection([probe(current=current), result(current)]
                                + [probe(current=current) for _ in range(8)])
        now = [0.0]
        with mock.patch.object(loader.time, 'monotonic', side_effect=lambda: now[0]), \
             mock.patch.object(loader, 'portrait_foreground', return_value={}), \
             mock.patch.object(self.registry, 'snapshot', wraps=self.registry.snapshot) as snapshots, \
             mock.patch.object(loader, 'asset_signature', wraps=loader.asset_signature) as tree_checks:
            self.assertEqual(session.step(connection, page()), 'mounted')
            initial_checks = tree_checks.call_count
            self.assertEqual(initial_checks, 2)  # Before packet read and after it.
            for tick in range(1, 8):
                now[0] = tick * loader.PROBE_INTERVAL
                self.assertEqual(session.step(connection, page()), 'mounted')
            self.assertEqual(snapshots.call_count, 1)
            self.assertEqual(tree_checks.call_count, initial_checks)
            self.assertEqual(session.diagnostics['assetSignatureCacheHits'], 7)
            now[0] = loader.ASSET_REVALIDATION_INTERVAL
            self.assertEqual(session.step(connection, page()), 'mounted')
            self.assertEqual(snapshots.call_count, 2)
            self.assertEqual(tree_checks.call_count, initial_checks + 1)
        self.assertEqual(len(self.registry.avatar_reads), 1)
        self.assertEqual(len(connection.calls), 10)

    def test_version_change_refreshes_snapshot_and_profile_without_waiting_for_deadline(self):
        self.cached_assets()
        self.avatar_fixture(1, 'milo')
        session = self.session()
        current = runtime(assetCacheVersion=1)
        connection = Connection([probe(current=current), result(current), probe(current=current), result(current)])
        now = [0.0]
        with mock.patch.object(loader.time, 'monotonic', side_effect=lambda: now[0]), \
             mock.patch.object(loader, 'portrait_foreground', return_value={}), \
             mock.patch.object(self.registry, 'snapshot', wraps=self.registry.snapshot) as snapshots:
            session.step(connection, page())
            self.registry.roles['milo']['bio'] = 'New acceptance criteria'
            self.registry.version += 1
            now[0] = loader.PROBE_INTERVAL
            self.assertEqual(session.step(connection, page()), 'mounted')
            self.assertEqual(snapshots.call_count, 2)
        self.assertEqual(show_argument(connection.calls[-1])['role']['bio'], 'New acceptance criteria')
        self.assertEqual(session.cached_snapshot['version'], self.registry.version)
        self.assertEqual(len(self.registry.avatar_reads), 1)

    def test_reconnection_revalidates_cached_material_and_full_snapshot(self):
        self.cached_assets()
        self.avatar_fixture(1, 'milo')
        session = self.session()
        current = runtime(assetCacheVersion=1)
        first = Connection([probe(current=current), result(current)])
        second = Connection([probe(current=current), result(current)])
        with mock.patch.object(loader.time, 'monotonic', return_value=0), \
             mock.patch.object(loader, 'portrait_foreground', return_value={}), \
             mock.patch.object(self.registry, 'snapshot', wraps=self.registry.snapshot) as snapshots, \
             mock.patch.object(loader, 'asset_signature', wraps=loader.asset_signature) as tree_checks:
            session.step(first, page())
            initial_checks = tree_checks.call_count
            session.connection_changed()
            self.assertEqual(len(session.asset_signatures), 0)
            self.assertEqual(session.step(second, page('new')), 'mounted')
            self.assertEqual(snapshots.call_count, 2)
            self.assertEqual(tree_checks.call_count, initial_checks + 1)
        self.assertEqual(len(self.registry.avatar_reads), 1)
        self.assertIn('avatarDataUrl', show_argument(second.calls[-1]))

    def test_tampered_avatar_is_not_reused_or_cached_and_repair_is_seen(self):
        self.cached_assets()
        image_id = self.avatar_fixture(1, 'milo')
        session = self.session()
        current = runtime(assetCacheVersion=1)
        connection = Connection([probe(current=current), result(current), probe(current=current), result(current),
                                 probe(current=current), result(current)])
        path = self.registry.assets_dir / (image_id + '.png')
        original = path.read_bytes()
        with mock.patch.object(loader, 'portrait_foreground', return_value={}):
            session.step(connection, page())
            old = path.stat()
            path.write_bytes(original[::-1])
            os.utime(path, ns=(old.st_atime_ns, old.st_mtime_ns))
            self.assertEqual(session.step(connection, page()), 'mounted')
            invalid = show_argument(connection.calls[3])
            self.assertEqual(invalid['avatarDataUrl'], '')
            self.assertNotIn('assetKey', invalid)
            path.write_bytes(original)
            self.assertEqual(session.step(connection, page()), 'mounted')
        self.assertEqual(len(self.registry.avatar_reads), 3)

    def test_invalid_nonempty_avatar_is_never_memoized(self):
        self.cached_assets()
        image_id = self.avatar_fixture(1, 'milo')
        self.registry.avatar_data = mock.Mock(return_value='data:image/png;base64,AA==')
        session = self.session()
        with mock.patch.object(loader, 'portrait_foreground', return_value={}):
            for _ in range(2):
                _, key = session._image_packet(image_id, loader.asset_signature(self.registry, image_id))
                self.assertIsNone(key)
        self.assertEqual(self.registry.avatar_data.call_count, 2)
        self.assertEqual(len(session.asset_cache), 0)

    def test_local_packet_lru_is_bounded_by_count_and_bytes(self):
        self.cached_assets()
        identifiers = [self.avatar_fixture(index) for index in range(8)]
        session = self.session()
        with mock.patch.object(loader, 'portrait_foreground', return_value={}):
            for image_id in identifiers:
                session._image_packet(image_id, loader.asset_signature(self.registry, image_id))
            self.assertEqual(len(session.asset_cache), 6)
            session._image_packet(identifiers[0], loader.asset_signature(self.registry, identifiers[0]))
            self.assertEqual(len(self.registry.avatar_reads), 9)
            self.assertLessEqual(session.asset_cache_bytes, 32 * 1024 * 1024)
            limited = self.session()
            with mock.patch.object(loader, 'ASSET_CACHE_BYTES', 300):
                for image_id in identifiers:
                    limited._image_packet(image_id, loader.asset_signature(self.registry, image_id))
                self.assertLessEqual(limited.asset_cache_bytes, 300)
                self.assertLessEqual(len(limited.asset_cache), 2)

    def test_stat_signature_detects_atomic_replacement_new_manifest_and_unsafe_sources(self):
        plugin = self.cached_assets()
        image_id = self.avatar_fixture(1, 'milo')
        original = loader.asset_signature(self.registry, image_id)
        replacement = self.layer_file.with_suffix('.replacement')
        replacement.write_bytes(self.layer_file.read_bytes())
        replacement.replace(self.layer_file)
        replaced = loader.asset_signature(self.registry, image_id)
        self.assertNotEqual(original, replaced)
        extra = plugin / 'assets/holo/new'
        extra.mkdir()
        (extra / 'manifest.json').write_text('{}')
        self.assertNotEqual(replaced, loader.asset_signature(self.registry, image_id))
        with mock.patch.object(loader, 'ASSET_STAT_ENTRIES', 2):
            self.assertIsNone(loader.asset_signature(self.registry, image_id))
        path = self.registry.assets_dir / (image_id + '.png')
        path.unlink()
        path.symlink_to(self.layer_file)
        self.assertIsNone(loader.asset_signature(self.registry, image_id))

    def test_title_change_between_probe_and_show_cannot_flash_the_previous_role(self):
        connection = Connection([probe(current=runtime(stale=True)), result({'stale': True})])
        self.assertEqual(self.session().step(connection, page()), 'waiting-context')
        self.assertIn('if(document.title!==', connection.calls[-1][1]['expression'])

    def test_failure_blocks_until_one_explicit_retry(self):
        connection = Connection([probe(current=runtime(mounted=False, failed=True))])
        with self.assertRaisesRegex(RuntimeError, '^own-controller-failed$'):
            self.session().step(connection, page())
        self.assertEqual(len(connection.calls), 1)
        session = self.session(); session.retry_requested = True
        retry = Connection([probe(current=runtime(mounted=False, failed=True)), result({'kind': 'removed'}),
                            result({'mounted': False}), result(runtime())])
        self.assertEqual(session.step(retry, page()), 'mounted')
        self.assertFalse(session.retry_requested)
        self.assertIn('api.uninstall()', retry.calls[1][1]['expression'])

    def test_foreign_globals_wrong_pages_and_script_exceptions_fail_closed(self):
        for observed in (result({'kind': 'conflict'}), probe(url='https://example.invalid'),
                         {'exceptionDetails': {'description': 'private text must not escape'}}):
            connection = Connection([observed])
            with self.assertRaises(RuntimeError) as failure:
                self.session().step(connection, page())
            self.assertNotIn('private text', str(failure.exception))
            self.assertEqual(len(connection.calls), 1)

    def test_preferences_only_save_known_role_layout_and_card_state(self):
        state = runtime(layout={'x': 90, 'y': float('inf'), 'width': 10, 'body': 'private'},
                        cardState={'flipped': True, 'collapsed': 'bad', 'body': 'private'})
        connection = Connection([probe(current=state), result(runtime())])
        self.session().step(connection, page())
        self.assertEqual(self.registry.saved[0], (SCOPE, 'milo', {'x': 90}, {'flipped': True}))
        self.assertEqual(loader.layout_only({'x': True, 'y': float('nan'), 'width': 321}), {})

    def test_shutdown_removes_only_own_api_and_persists_own_preferences(self):
        connection = Connection([result(runtime(layout={'x': 80}))])
        self.session().shutdown(connection)
        expression = connection.calls[0][1]['expression']
        self.assertIn('api.brand!=="mai-work-badges/2"', expression)
        self.assertIn('api.uninstall()', expression)
        self.assertEqual(self.registry.prefs_get(SCOPE)['layout'], {'x': 80})

    def test_enroll_preserves_scope_across_new_target_ids_and_uses_no_cdp_connection(self):
        with mock.patch.object(loader, 'fetch_targets', return_value=[page()]):
            loader.enroll(self.state, 9347, ask=lambda _: '1')
        scope = loader.config_at(self.state)['scope']
        self.assertTrue(loader.valid_scope(scope))
        with mock.patch.object(loader, 'fetch_targets', return_value=[page('new')]):
            loader.enroll(self.state, 9347, ask=lambda _: '1')
        self.assertEqual(loader.config_at(self.state)['scope'], scope)
        self.assertEqual(loader.config_at(self.state)['target']['preferredId'], 'new')

    def test_enroll_cancellation_and_wrong_endpoint_do_not_create_config(self):
        with mock.patch.object(loader, 'fetch_targets', return_value=[page()]):
            loader.enroll(self.state, 9347, ask=lambda _: '')
        self.assertFalse((self.state / 'config.json').exists())
        foreign = {**page(), 'webSocketDebuggerUrl': 'ws://example.invalid:9347/devtools/page/one'}
        with mock.patch.object(loader, 'fetch_targets', return_value=[foreign]), self.assertRaises(ValueError):
            loader.enroll(self.state, 9347, ask=lambda _: '1')
        self.assertFalse((self.state / 'config.json').exists())

    def test_invalid_config_and_duplicate_service_lock_fail_closed(self):
        for value in ({}, {'schema': 1, 'port': 9347, 'target': self.selection, 'scope': 'target-one'}, []):
            (self.state / 'config.json').write_text(json.dumps(value))
            with self.assertRaises(ValueError):
                loader.config_at(self.state)
        with loader.service_lock(self.state) as first:
            self.assertTrue(first)
            with loader.service_lock(self.state) as second:
                self.assertFalse(second)

    def test_real_registry_resolves_exact_title_and_accepts_scoped_preferences(self):
        registry = loader.registry_module().Registry(self.state / 'registry')
        self.addCleanup(registry.close)
        version = registry.snapshot()['version']
        registry.bind('milo', 'title', TITLE, TITLE, version)
        session = loader.BadgeSession(registry, SCOPE, '/* mock renderer */', 'rev', '')
        connection = Connection([probe(), result({'mounted': False}), result(runtime(cardState={'flipped': True, 'collapsed': False}))])
        self.assertEqual(session.step(connection, page()), 'mounted')
        saved = registry.prefs_get(SCOPE)
        self.assertEqual(saved['roles']['milo']['flipped'], True)
        self.assertEqual(saved['layout']['x'], 40)
        self.assertIsNone(registry.resolve({'title': TITLE + ' renamed', 'threadKey': None}))
        metadata = registry.snapshot()['contexts'][0]
        self.assertEqual(metadata['contextKey'], 'title:' + TITLE)
        self.assertIsNone(metadata['threadKey'])

    def test_real_registry_version_observes_another_connection_edit_on_next_fast_probe(self):
        root = self.state / 'registry'
        registry = loader.registry_module().Registry(root)
        self.addCleanup(registry.close)
        bound = registry.bind('milo', 'title', TITLE, TITLE, registry.snapshot()['version'])
        writer = loader.registry_module().Registry(root)
        self.addCleanup(writer.close)
        session = loader.BadgeSession(registry, SCOPE, '/* mock renderer */', 'rev', '')
        connection = Connection([probe(current=runtime()), result(runtime()), probe(current=runtime()),
                                 probe(current=runtime()), result(runtime())])
        now = [0.0]
        with mock.patch.object(loader.time, 'monotonic', side_effect=lambda: now[0]), \
             mock.patch.object(registry, 'snapshot', wraps=registry.snapshot) as snapshots:
            session.step(connection, page())
            now[0] = loader.PROBE_INTERVAL
            session.step(connection, page())
            self.assertEqual(snapshots.call_count, 1)
            writer.upsert_role({'id': 'milo', 'bio': 'Saved by the management page'}, bound['version'])
            now[0] += loader.PROBE_INTERVAL
            self.assertEqual(session.step(connection, page()), 'mounted')
            self.assertEqual(snapshots.call_count, 2)
        self.assertEqual(show_argument(connection.calls[-1])['role']['bio'], 'Saved by the management page')
        self.assertEqual(session.diagnostics['versionChecks'], 3)

    def test_cached_snapshot_does_not_swallow_registry_version_errors(self):
        session = self.session()
        first = Connection([probe(current=runtime()), result(runtime())])
        session.step(first, page())
        self.registry._version = mock.Mock(side_effect=loader.sqlite3.OperationalError('fixture unavailable'))
        blocked = Connection([probe(current=runtime())])
        with self.assertRaises(loader.sqlite3.OperationalError):
            session.step(blocked, page())
        self.assertEqual(len(blocked.calls), 1)

    def test_runtime_resources_are_read_locally_without_executing_the_source(self):
        plugin = self.state / 'plugin'
        (plugin / 'runtime').mkdir(parents=True)
        (plugin / 'assets').mkdir()
        (plugin / 'runtime/renderer.js').write_text('/* local source */')
        (plugin / 'assets/BricolageGrotesque.ttf').write_bytes(b'mock-font')
        source, revision, font = loader.runtime_at(plugin)
        self.assertEqual(source, '/* local source */')
        self.assertEqual(len(revision), 64)
        self.assertTrue(font.startswith('data:font/ttf;base64,'))

    def test_watch_reconnects_with_same_scope_and_prefs_after_application_restart(self):
        self.config()
        first = Connection([probe(), result({'mounted': False}), result(runtime(layout={'x': 99}))])
        second = Connection([probe(), result({'mounted': False}), result(runtime(layout={'x': 99})), result(runtime(layout={'x': 99}))])
        discoveries = [[page()], ConnectionRefusedError(), [page('new')]]
        pulse = Pulse(3, elapsed_per_wait=2.0)
        def fetch(**_):
            item = discoveries.pop(0)
            if isinstance(item, BaseException): raise item
            return item
        with mock.patch.object(loader, 'fetch_targets', side_effect=fetch), \
             mock.patch.object(loader, 'CDPConnection', side_effect=[first, second]), \
             mock.patch.object(loader, 'new_registry', return_value=self.registry), \
             mock.patch.object(loader, 'runtime_at', return_value=('/* mock renderer */', 'rev', 'font')), \
             mock.patch.object(loader.threading, 'Event', return_value=pulse), \
             mock.patch.object(loader.time, 'monotonic', side_effect=lambda: pulse.now), \
             mock.patch.object(loader.signal, 'signal', return_value=None):
            self.assertEqual(loader.watch(self.state), 0)
        self.assertIn('"x": 99', second.calls[2][1]['expression'])
        self.assertIn('"fontDataUrl": "font"', second.calls[2][1]['expression'])
        self.assertTrue(first.closed and second.closed)
        self.assertTrue(self.registry.closed)
        self.assertEqual(self.registry.prefs_get(SCOPE)['layout']['x'], 99)
        self.assertEqual(loader.read_json(self.state / 'status.json')['state'], 'stopped')

    def test_watch_probes_fast_but_reuses_connection_and_limits_disk_heartbeats(self):
        self.config()
        pulse = Pulse(10)
        connection = Connection([probe(), result({'mounted': False}), result(runtime())]
                                + [probe(current=runtime()) for _ in range(9)] + [result(runtime())])
        atomic_json = loader.atomic_json
        with mock.patch.object(loader, 'fetch_targets', return_value=[page()]) as discovery, \
             mock.patch.object(loader, 'CDPConnection', return_value=connection) as connect, \
             mock.patch.object(loader, 'new_registry', return_value=self.registry), \
             mock.patch.object(loader, 'runtime_at', return_value=('/* mock renderer */', 'rev', 'font')), \
             mock.patch.object(loader.threading, 'Event', return_value=pulse), \
             mock.patch.object(loader.time, 'monotonic', side_effect=lambda: pulse.now), \
             mock.patch.object(loader.signal, 'signal', return_value=None), \
             mock.patch.object(loader, 'atomic_json', wraps=atomic_json) as writes:
            self.assertEqual(loader.watch(self.state), 0)
        self.assertEqual(discovery.call_count, 2)
        self.assertEqual(connect.call_count, 1)
        self.assertEqual(len(connection.calls), 13)
        self.assertEqual(pulse.waits, [.25] * 10)
        status_writes = [call.args[1] for call in writes.call_args_list if call.args[0].name == 'status.json']
        self.assertEqual([value['state'] for value in status_writes], ['mounted', 'mounted', 'stopped'])
        self.assertTrue(all(value['intervalSeconds'] == .25 for value in status_writes))
        self.assertEqual(len(self.registry.contexts), 2)
        self.assertEqual(len(self.registry.saved), 1)

    def test_lost_connection_is_rediscovered_on_next_fast_probe(self):
        self.config()
        pulse = Pulse(4)
        first = Connection([probe(), result({'mounted': False}), result(runtime()), OSError('offline fixture')])
        second = Connection([probe(), result({'mounted': False}), result(runtime()),
                             probe(current=runtime()), result(runtime())])
        discoveries_at = []
        def fetch(**_):
            discoveries_at.append(pulse.now)
            return [page('one' if len(discoveries_at) == 1 else 'new')]
        with mock.patch.object(loader, 'fetch_targets', side_effect=fetch), \
             mock.patch.object(loader, 'CDPConnection', side_effect=[first, second]), \
             mock.patch.object(loader, 'new_registry', return_value=self.registry), \
             mock.patch.object(loader, 'runtime_at', return_value=('/* mock renderer */', 'rev', 'font')), \
             mock.patch.object(loader.threading, 'Event', return_value=pulse), \
             mock.patch.object(loader.time, 'monotonic', side_effect=lambda: pulse.now), \
             mock.patch.object(loader.signal, 'signal', return_value=None):
            self.assertEqual(loader.watch(self.state), 0)
        self.assertEqual(discoveries_at, [0, .5])
        self.assertEqual(pulse.waits, [.25] * 4)
        self.assertTrue(first.closed and second.closed)

    def test_absent_application_keeps_slower_discovery_backoff(self):
        self.config()
        pulse = Pulse(3)
        with mock.patch.object(loader, 'fetch_targets', side_effect=ConnectionRefusedError()) as discovery, \
             mock.patch.object(loader, 'new_registry', return_value=self.registry), \
             mock.patch.object(loader, 'runtime_at', return_value=('/* mock renderer */', 'rev', 'font')), \
             mock.patch.object(loader.threading, 'Event', return_value=pulse), \
             mock.patch.object(loader.time, 'monotonic', side_effect=lambda: pulse.now), \
             mock.patch.object(loader.signal, 'signal', return_value=None):
            self.assertEqual(loader.watch(self.state), 0)
        self.assertEqual(discovery.call_count, 3)
        self.assertEqual(pulse.waits, [2.0] * 3)

    def test_watch_rejects_invalid_probe_intervals_before_reading_or_connecting(self):
        for interval in (True, 0, -1, float('inf'), float('nan'), 'fast'):
            with self.subTest(interval=interval), self.assertRaises(ValueError):
                loader.watch(self.state, interval=interval)

    def test_watch_persists_failure_and_does_not_reinject_until_explicit_retry(self):
        self.config()
        connection = Connection([probe(), result({'mounted': False}), {'exceptionDetails': {'description': 'blocked resource'}}])
        with mock.patch.object(loader, 'fetch_targets', return_value=[page()]) as discovery, \
             mock.patch.object(loader, 'CDPConnection', return_value=connection), \
             mock.patch.object(loader, 'new_registry', return_value=self.registry), \
             mock.patch.object(loader, 'runtime_at', return_value=('/* mock renderer */', 'rev', 'font')), \
             mock.patch.object(loader.threading, 'Event', return_value=Pulse(3)), \
             mock.patch.object(loader.signal, 'signal', return_value=None):
            self.assertEqual(loader.watch(self.state), 0)
        self.assertEqual(discovery.call_count, 1)
        self.assertEqual(loader.read_json(self.state / 'failure.json')['reason'], 'page-evaluation-failed')
        loader.cli(['retry', '--state-dir', str(self.state)])
        self.assertFalse((self.state / 'failure.json').exists())

    def test_registry_validation_failure_is_reported_without_launchd_crash_or_raw_text(self):
        self.config()
        error = loader.registry_module().ValidationError('private registry description')
        self.registry.record_context = mock.Mock(side_effect=error)
        connection = Connection([probe()])
        import io
        with mock.patch.object(loader, 'fetch_targets', return_value=[page()]), \
             mock.patch.object(loader, 'CDPConnection', return_value=connection), \
             mock.patch.object(loader, 'new_registry', return_value=self.registry), \
             mock.patch.object(loader, 'runtime_at', return_value=('/* mock renderer */', 'rev', 'font')), \
             mock.patch.object(loader.threading, 'Event', return_value=Pulse(1)), \
             mock.patch.object(loader.signal, 'signal', return_value=None), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(loader.watch(self.state), 0)
        self.assertIn('waiting-registry', output.getvalue())
        self.assertNotIn('private registry description', output.getvalue())
        self.assertTrue(self.registry.closed)
        self.assertFalse((self.state / 'failure.json').exists())

    @unittest.skipUnless(shutil.which('node'), 'Node is optional for the offline DOM-model integration check')
    def test_python_asset_protocol_against_real_renderer_with_memory_dom(self):
        renderer = (ROOT / 'runtime/renderer.js').read_text()
        if 'assetCacheVersion' not in renderer:
            self.skipTest('Rebuild the renderer to run the new cache protocol integration')
        self.cached_assets()
        self.avatar_fixture(1, 'milo')
        self.avatar_fixture(2, 'maxie')
        extra_images = [self.avatar_fixture(index) for index in range(3, 10)]
        connection = NodeMemoryConnection()
        self.addCleanup(connection.close)
        session = loader.BadgeSession(self.registry, SCOPE, renderer, 'cache-integration', '')
        with mock.patch.object(loader, 'portrait_foreground', return_value={}):
            self.assertEqual(session.step(connection, page()), 'mounted')
            first = show_argument(connection.calls[-1])
            self.assertIn('avatarDataUrl', first)
            connection.command('imagesReady')
            connection.command('title', value=OTHER_TITLE)
            self.assertEqual(session.step(connection, page()), 'mounted')
            connection.command('imagesReady')
            connection.command('title', value=TITLE)
            self.assertEqual(session.step(connection, page()), 'mounted')
            warm = show_argument(connection.calls[-1])
            self.assertEqual(warm['assetKey'], first['assetKey'])
            self.assertNotIn('avatarDataUrl', warm)
            self.assertEqual(len(self.registry.avatar_reads), 2)
            self.assertTrue(connection.command('evaluate', expression='window.MaiWorkBadgeRuntime.status()')
                            ['result']['value']['uiCacheHit'])
            self.registry.roles['milo']['bio'] = 'Profile text is still current with cached images'
            self.assertEqual(session.step(connection, page()), 'mounted')
            self.assertIn('Profile text is still current', connection.command('content')['text'])
            # Another owned caller can fill the page's LRU independently. The
            # loader retains its own sent keys and must recover a one-shot miss.
            for index, image_id in enumerate(extra_images):
                packet, key = session._image_packet(image_id, loader.asset_signature(self.registry, image_id))
                role = {**self.registry.roles['milo'], 'id': 'fixture-' + str(index), 'imageId': image_id}
                argument = {'role': role, 'contextKey': 'title:' + TITLE, 'assetKey': key, **packet}
                response = connection.call('Runtime.evaluate', {'expression': loader.own_call(
                    'return api.show(' + json.dumps(argument) + ');')})
                self.assertTrue(response['result']['value']['mounted'])
            previous_calls = len(connection.calls)
            self.assertEqual(session.step(connection, page()), 'mounted')
            self.assertEqual(len(connection.calls) - previous_calls, 3)
            reference = show_argument(connection.calls[previous_calls + 1])
            retry = show_argument(connection.calls[previous_calls + 2])
            self.assertNotIn('avatarDataUrl', reference)
            self.assertIn('avatarDataUrl', retry)
            self.assertEqual(reference['assetKey'], retry['assetKey'])
            self.assertEqual(connection.command('evaluate', expression='window.MaiWorkBadgeRuntime.status()')
                             ['result']['value']['roleId'], 'milo')

    @unittest.skipUnless(shutil.which('node'), 'Node is optional for the offline DOM-model integration check')
    def test_python_reconciliation_against_real_renderer_with_memory_dom(self):
        connection = NodeMemoryConnection()
        self.addCleanup(connection.close)
        renderer = (ROOT / 'runtime/renderer.js').read_text()
        session = loader.BadgeSession(self.registry, SCOPE, renderer, 'test-runtime-revision', '')
        self.assertEqual(session.step(connection, page()), 'mounted')
        connection.command('flip')
        self.assertEqual(session.step(connection, page()), 'mounted')
        self.assertTrue(self.registry.prefs_get(SCOPE)['roles']['milo']['flipped'])
        dismissed = connection.command('close')
        self.assertEqual(dismissed['roleId'], 'milo')
        self.assertTrue(dismissed['restorable'])
        self.assertEqual(session.step(connection, page()), 'dismissed')
        self.registry.roles['milo']['bio'] = 'Updated while the badge was closed'
        self.assertEqual(session.step(connection, page()), 'dismissed')
        restored = connection.command('restore')
        self.assertTrue(restored['mounted'])
        self.assertFalse(restored['dismissed'])
        self.assertTrue(restored['cardState']['flipped'])
        self.assertIn('Updated while the badge was closed', connection.command('content')['text'])
        self.assertEqual(session.step(connection, page()), 'mounted')
        connection.command('close')
        self.assertEqual(session.step(connection, page()), 'dismissed')
        self.registry.bindings['title:' + TITLE] = 'maxie'
        self.assertEqual(session.step(connection, page()), 'mounted')
        self.assertEqual(connection.command('status')['roleId'], 'maxie')
        self.registry.bindings['title:' + TITLE] = 'milo'
        self.assertEqual(session.step(connection, page()), 'dismissed')
        self.assertFalse(connection.command('status')['mounted'])
        self.assertFalse(connection.command('status')['failed'])
        self.registry.bindings['title:' + TITLE] = 'maxie'
        self.assertEqual(session.step(connection, page()), 'mounted')
        stale = connection.command('title', value=OTHER_TITLE)
        self.assertFalse(stale['mounted']); self.assertTrue(stale['stale'])
        self.assertEqual(session.step(connection, page()), 'mounted')
        connection.command('title', value='Unbound conversation')
        self.assertEqual(session.step(connection, page()), 'unbound')
        self.assertFalse(connection.command('status')['mounted'])
        connection.command('title', value='ChatGPT')
        self.assertEqual(session.step(connection, page()), 'unknown-context')
        self.assertFalse(connection.command('status')['failed'])
        session.shutdown(connection)
        self.assertTrue(connection.command('status')['absent'])


if __name__ == '__main__':
    unittest.main()
