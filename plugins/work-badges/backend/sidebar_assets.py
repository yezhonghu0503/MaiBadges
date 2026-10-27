"""Source-addressed sidebar art for any explicitly bound, enabled user role.

The public package has no named-employee sidebar manifest. Prepared art is
chosen only by its source image digest, and ordinary uploads use the registry's
validated avatar bytes. Importing this module never accesses an application.
"""
from __future__ import annotations

from pathlib import Path
import re

from .holo_assets import DEMO_SOURCE_ID, display_layers

SHA = re.compile(r'[a-f0-9]{64}\Z')


def sidebar_art(image_id, plugin, registry=None):
    """Return prepared public art or the user's original validated upload.

    A generic geometric background is optional decoration; the character always
    belongs to the requested source image. Never infer an employee from a name.
    """
    if not isinstance(image_id, str) or not SHA.fullmatch(image_id) or registry is None:
        return {}
    avatar = registry.avatar_data(image_id)
    if not avatar:
        return {}
    assets = Path(plugin) / 'assets/holo'
    layers = display_layers(image_id, assets)
    planes = layers.get('holoAssets') or {}
    character = planes.get('character') or layers.get('foregroundDataUrl') or avatar
    background = planes.get('background')
    if not background and DEMO_SOURCE_ID:
        background = (display_layers(DEMO_SOURCE_ID, assets).get('holoAssets') or {}).get('background')
    result = {'characterDataUrl': character}
    if background:
        result['backgroundDataUrl'] = background
    return result


def sidebar_items(snapshot, plugin, registry=None, asset_reader=None):
    """Build the renderer's stable item protocol without relying on seed IDs."""
    bindings = snapshot.get('bindings')
    roles = snapshot.get('roles')
    if not isinstance(bindings, list) or not isinstance(roles, list):
        return []
    result = []
    for role in roles:
        if (not isinstance(role, dict) or not role.get('enabled')
                or not isinstance(role.get('id'), str) or not role['id']
                or not isinstance(role.get('name'), str)):
            continue
        matching = [{'kind': binding['kind'], 'key': binding['key']} for binding in bindings
                    if isinstance(binding, dict) and binding.get('roleId') == role['id']
                    and binding.get('kind') in ('title', 'thread')
                    and isinstance(binding.get('key'), str) and binding['key']]
        if matching:
            art = (asset_reader(role.get('imageId')) if asset_reader is not None
                   else sidebar_art(role.get('imageId'), plugin, registry))
            result.append({'roleId': role['id'], 'name': role['name'], 'role': role.get('role', ''),
                           'bindings': matching, **art})
    return result
