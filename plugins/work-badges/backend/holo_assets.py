"""Read optional, content-addressed display art without changing user avatars.

Each additional role can ship ``assets/holo/<name>/manifest.json``.  It names
its exact source image SHA256, six PNG files, and their SHA256 values.  Role
names are never used to choose artwork.
"""
from __future__ import annotations

import base64
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import re

ASSETS = Path(__file__).resolve().parent.parent / 'assets' / 'holo'
# The alias remains for clients using the pre-public sample field name.
# It is derived from public demo bytes, never a hard-coded personal avatar.
try:
    DEMO_SOURCE_ID = hashlib.sha256((ASSETS.parent / 'demo.png').read_bytes()).hexdigest()
except OSError:
    DEMO_SOURCE_ID = ''
MILO_SOURCE_ID = DEMO_SOURCE_ID
MATERIAL_KINDS = ('character', 'background', 'ui', 'structure')
BUNDLE_KINDS = ('foreground', 'contour') + MATERIAL_KINDS
MAX_PNG_BYTES = 3 * 1024 * 1024
SHA256 = re.compile(r'[0-9a-f]{64}\Z')
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'


def _safe_file(root, filename):
    """Do not follow either a file symlink or a linked parent directory."""
    if not isinstance(filename, str) or not filename or '\x00' in filename:
        return None
    relative = Path(filename)
    if relative.is_absolute() or '..' in relative.parts:
        return None
    current = Path(root)
    if current.is_symlink():
        return None
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            return None
    return current if current.is_file() else None


def _manifest(path):
    try:
        if path.is_symlink() or path.parent.is_symlink() or not path.is_file():
            return None
        with path.open('rb') as handle:
            raw = handle.read(64 * 1024 + 1)
        if len(raw) > 64 * 1024:
            return None
        value = json.loads(raw)
        return value if isinstance(value, dict) else None
    except (OSError, ValueError, UnicodeError):
        return None


def _bundle(image_id, assets_dir):
    """Find one unambiguous source-bound manifest; ignore malformed bundles."""
    if not isinstance(image_id, str) or not SHA256.fullmatch(image_id):
        return None
    root = Path(assets_dir)
    if root.is_symlink() or not root.is_dir():
        return None
    matches = []
    try:
        children = sorted(root.iterdir())
    except OSError:
        return None
    for folder in children:
        if folder.is_symlink() or not folder.is_dir():
            continue
        manifest = _manifest(folder / 'manifest.json')
        if manifest and manifest.get('sourceImageId') == image_id:
            matches.append((folder, manifest))
    if len(matches) != 1:
        return None
    folder, manifest = matches[0]
    files, hashes = manifest.get('files'), manifest.get('sha256')
    if not isinstance(files, dict) or not isinstance(hashes, dict):
        return None
    for kind in BUNDLE_KINDS:
        filename = files.get(kind)
        if (not isinstance(filename, str) or Path(filename).suffix.lower() != '.png'
                or not isinstance(hashes.get(filename), str)
                or not SHA256.fullmatch(hashes[filename])):
            return None
    return folder, files, hashes


@lru_cache(maxsize=48)
def _read_png(path, digest, stamp):
    # The stat stamp invalidates the cache after a local asset replacement.
    try:
        with path.open('rb') as handle:
            data = handle.read(MAX_PNG_BYTES + 1)
        if len(data) > MAX_PNG_BYTES or not data.startswith(PNG_SIGNATURE):
            return b''
        if digest and hashlib.sha256(data).hexdigest() != digest:
            return b''
        return data
    except OSError:
        return b''


def _png(root, filename, digest=None):
    try:
        path = _safe_file(root, filename)
        if path is None:
            return b''
        stat = path.stat()
        return _read_png(path, digest, (stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))
    except OSError:
        return b''


def _data_url(raw):
    return 'data:image/png;base64,' + base64.b64encode(raw).decode('ascii') if raw else ''


def _layer_data(image_id, kind, assets_dir):
    """Only matching source bytes can use prepared art, never a role name."""
    bundle = _bundle(image_id, assets_dir)
    if bundle is None or kind not in BUNDLE_KINDS:
        return ''
    root, files, hashes = bundle
    return _data_url(_png(root, files[kind], hashes[files[kind]]))


def foreground_data(image_id, assets_dir=ASSETS):
    return _layer_data(image_id, 'foreground', assets_dir) if isinstance(image_id, str) else ''


def contour_data(image_id, assets_dir=ASSETS):
    return _layer_data(image_id, 'contour', assets_dir) if isinstance(image_id, str) else ''


def material_assets(image_id, assets_dir=ASSETS):
    bundle = _bundle(image_id, assets_dir)
    if bundle is None:
        return {}
    root, files, hashes = bundle
    digests = {kind: hashes[files[kind]] for kind in MATERIAL_KINDS}
    planes = {}
    sizes = set()
    for kind in MATERIAL_KINDS:
        digest = digests[kind]
        if not isinstance(digest, str) or not SHA256.fullmatch(digest):
            return {}
        raw = _png(root, files[kind], digest)
        # The shader requires four aligned RGBA PNG planes on the same canvas.
        if len(raw) < 33 or raw[12:16] != b'IHDR' or raw[25] != 6:
            return {}
        sizes.add(raw[16:24])
        planes[kind] = _data_url(raw)
    return planes if len(sizes) == 1 else {}


def display_layers(image_id, assets_dir=ASSETS):
    foreground = foreground_data(image_id, assets_dir)
    return {'foregroundDataUrl': foreground,
            'contourDataUrl': contour_data(image_id, assets_dir) if foreground else '',
            'holoAssets': material_assets(image_id, assets_dir) if foreground else {}}
