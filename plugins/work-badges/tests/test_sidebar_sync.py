"""Sidebar reconciliation uses only the owned in-memory loader transport."""
import base64
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from test_loader import Connection, Registry, ROOT, SCOPE, TINY_PNG, loader, page, probe, result, runtime


BUILD = 'sidebar-test-build'


def state(**changes):
    return runtime(**{'build': BUILD, 'sidebarVersion': 1, 'sidebar': {'cards': 2}, **changes})


class ListBindingRegistry(Registry):
    """Memory adapter with the production registry's versioned write contract."""
    def edit_role(self, role_id, **changes):
        if any(self.roles[role_id].get(key) != value for key, value in changes.items()):
            self.roles[role_id].update(changes)
            self.version += 1

    def clear_bindings(self):
        if self.bindings:
            self.bindings.clear()
            self.version += 1

    def snapshot(self):
        value = super().snapshot()
        value['bindings'] = [
            {'kind': key.split(':', 1)[0], 'key': key.split(':', 1)[1], 'roleId': role_id}
            for key, role_id in self.bindings.items()
        ]
        return value


class SidebarSyncTests(unittest.TestCase):
    def setUp(self):
        self.registry = ListBindingRegistry()
        self.patchers = [
            mock.patch.object(loader, 'fetch_targets', side_effect=AssertionError('No real discovery')),
            mock.patch.object(loader, 'CDPConnection', side_effect=AssertionError('No real connection')),
            mock.patch.object(loader, 'asset_signature', return_value=None),
            mock.patch.object(loader, 'portrait_foreground', return_value={}),
        ]
        for patcher in self.patchers:
            patcher.start(); self.addCleanup(patcher.stop)
        self.session = loader.BadgeSession(self.registry, SCOPE,
            "const BUILD = 'sidebar-test-build'; /* owned renderer fixture */", 'revision', probe='/* probe fixture */')

    @staticmethod
    def sidebar_calls(connection):
        return [call for call in connection.calls if 'api.configureSidebar(' in call[1]['expression']]

    @staticmethod
    def sidebar_argument(call):
        expression = call[1]['expression']
        start = expression.index('api.configureSidebar(') + len('api.configureSidebar(')
        return json.JSONDecoder().raw_decode(expression[start:])[0]

    def real_registry_session(self):
        temporary = tempfile.TemporaryDirectory(prefix='.sidebar-sync-', dir=Path(__file__).parent)
        self.addCleanup(temporary.cleanup)
        registry = loader.registry_module().Registry(Path(temporary.name))
        self.addCleanup(registry.close)
        snapshot = registry.snapshot()
        snapshot = registry.bind('milo', 'title', 'Milo（互动运营）', 'Milo', snapshot['version'])
        registry.bind('maxie', 'title', 'Maxie（资深分析师）', 'Maxie', snapshot['version'])
        writer = loader.registry_module().Registry(Path(temporary.name))
        self.addCleanup(writer.close)
        session = loader.BadgeSession(registry, SCOPE,
            "const BUILD = 'sidebar-test-build'; /* owned renderer fixture */", 'revision', probe='/* probe fixture */')
        return registry, writer, session

    def test_unbound_current_chat_defines_and_configures_other_bound_roles_before_hide(self):
        empty = state(mounted=False, roleId=None, contextKey=None)
        connection = Connection([probe(title='An unrelated chat'), result(empty), result(empty), result(empty)])
        self.assertEqual(self.session.step(connection, page(title='An unrelated chat')), 'unbound')
        expressions = [call[1]['expression'] for call in connection.calls]
        self.assertIn('owned renderer fixture', expressions[1])
        self.assertIn('api.configureSidebar(', expressions[2])
        self.assertIn('api.hide(', expressions[3])
        payload = self.sidebar_argument(connection.calls[2])
        self.assertEqual({item['roleId'] for item in payload['items']}, {'milo', 'maxie'})
        self.assertFalse(any('api.show(' in value for value in expressions))

    def test_unchanged_payload_is_sent_once_until_connection_changes(self):
        current = state()
        connection = Connection([probe(current=current), result(current), result(current),
                                 probe(current=current), probe(current=current), result(current), result(current)])
        self.assertEqual(self.session.step(connection, page()), 'mounted')
        self.assertEqual(self.session.step(connection, page()), 'mounted')
        self.assertEqual(len(self.sidebar_calls(connection)), 1)
        self.session.connection_changed()
        self.assertEqual(self.session.step(connection, page()), 'mounted')
        self.assertEqual(len(self.sidebar_calls(connection)), 2)
        self.assertEqual(self.sidebar_argument(self.sidebar_calls(connection)[0]),
                         self.sidebar_argument(self.sidebar_calls(connection)[1]))

    def test_other_role_edit_syncs_before_current_mounted_fast_return(self):
        current = state()
        connection = Connection([probe(current=current), result(current), result(current),
                                 probe(current=current), result(current)])
        self.assertEqual(self.session.step(connection, page()), 'mounted')
        self.registry.edit_role('maxie', name='Maxie updated')
        self.assertEqual(self.session.step(connection, page()), 'mounted')
        payloads = [self.sidebar_argument(call) for call in self.sidebar_calls(connection)]
        self.assertEqual(len(payloads), 2)
        self.assertEqual(next(item for item in payloads[-1]['items'] if item['roleId'] == 'maxie')['name'], 'Maxie updated')
        self.assertEqual(sum('api.show(' in call[1]['expression'] for call in connection.calls), 1)

    def test_other_role_edit_syncs_before_current_dismissed_fast_return(self):
        current = state(mounted=False, dismissed=True)
        connection = Connection([probe(current=current), result(current), result(current),
                                 probe(current=current), result(current)])
        self.assertEqual(self.session.step(connection, page()), 'dismissed')
        self.registry.edit_role('maxie', enabled=False)
        self.assertEqual(self.session.step(connection, page()), 'dismissed')
        payloads = [self.sidebar_argument(call) for call in self.sidebar_calls(connection)]
        self.assertEqual([item['roleId'] for item in payloads[-1]['items']], ['milo'])
        self.assertEqual(sum('api.show(' in call[1]['expression'] for call in connection.calls), 1)

    def test_owned_old_build_is_redefined_then_sidebar_resynchronized(self):
        current = state()
        old = {**current, 'build': 'previous-owned-build'}
        empty = state(mounted=False, roleId=None, contextKey=None)
        connection = Connection([probe(current=current), result(current), result(current),
                                 probe(current=old), result(empty), result(empty), result(current)])
        self.assertEqual(self.session.step(connection, page()), 'mounted')
        self.assertEqual(self.session.step(connection, page()), 'mounted')
        expressions = [call[1]['expression'] for call in connection.calls]
        self.assertIn('owned renderer fixture', expressions[-3])
        self.assertIn('api.configureSidebar(', expressions[-2])
        self.assertIn('api.show(', expressions[-1])
        self.assertEqual(len(self.sidebar_calls(connection)), 2)

    def test_unbinding_last_role_clears_sidebar_without_rebuilding_current_card(self):
        current = state()
        empty = state(sidebar={'cards': 0})
        connection = Connection([probe(current=current), result(current), result(current),
                                 probe(current=current), result(empty), result(empty)])
        self.assertEqual(self.session.step(connection, page()), 'mounted')
        self.registry.clear_bindings()
        self.assertEqual(self.session.step(connection, page()), 'unbound')
        self.assertEqual(self.sidebar_argument(self.sidebar_calls(connection)[-1]), {'items': [], 'projectTitle': ''})

    def test_real_registry_cross_connection_edit_and_disable_sync_before_fast_returns(self):
        for dismissed in (False, True):
            with self.subTest(dismissed=dismissed):
                registry, writer, session = self.real_registry_session()
                current = state(mounted=not dismissed, dismissed=dismissed)
                connection = Connection([probe(current=current), result(current), result(current),
                                         probe(current=current), result(current),
                                         probe(current=current), result(current)])
                with mock.patch.object(loader.time, 'monotonic', return_value=0), \
                     mock.patch.object(registry, 'snapshot', wraps=registry.snapshot) as snapshots:
                    self.assertEqual(session.step(connection, page()), 'dismissed' if dismissed else 'mounted')
                    revision = writer.snapshot()['version']
                    saved = writer.upsert_role({'id': 'maxie', 'name': 'Maxie updated'}, revision)
                    self.assertEqual(session.step(connection, page()), 'dismissed' if dismissed else 'mounted')
                    payload = self.sidebar_argument(self.sidebar_calls(connection)[-1])
                    self.assertEqual(next(item for item in payload['items'] if item['roleId'] == 'maxie')['name'], 'Maxie updated')
                    writer.set_enabled('maxie', False, saved['version'])
                    self.assertEqual(session.step(connection, page()), 'dismissed' if dismissed else 'mounted')
                    self.assertEqual(snapshots.call_count, 3)
                payload = self.sidebar_argument(self.sidebar_calls(connection)[-1])
                self.assertEqual([item['roleId'] for item in payload['items']], ['milo'])
                self.assertEqual(sum('api.show(' in call[1]['expression'] for call in connection.calls), 1)

    def test_real_registry_cross_connection_unbind_clears_sidebar_on_next_probe(self):
        registry, writer, session = self.real_registry_session()
        current = state()
        empty = state(mounted=False, sidebar={'cards': 0})
        connection = Connection([probe(current=current), result(current), result(current),
                                 probe(current=current), result(empty), result(empty)])
        with mock.patch.object(loader.time, 'monotonic', return_value=0), \
             mock.patch.object(registry, 'snapshot', wraps=registry.snapshot) as snapshots:
            self.assertEqual(session.step(connection, page()), 'mounted')
            saved = writer.snapshot()
            for binding in saved['bindings']:
                updated = writer.unbind(binding['id'], saved['version'])
                saved = updated
            self.assertEqual(session.step(connection, page()), 'unbound')
            self.assertEqual(snapshots.call_count, 2)
        self.assertEqual(self.sidebar_argument(self.sidebar_calls(connection)[-1]), {'items': [], 'projectTitle': ''})
        self.assertEqual(sum('api.show(' in call[1]['expression'] for call in connection.calls), 1)
        self.assertIn('api.hide(', connection.calls[-1][1]['expression'])

    def test_explicit_project_scope_is_forwarded_and_scope_change_resyncs(self):
        current = state()
        self.session.sidebar_project_title = 'Confirmed Project'
        connection = Connection([probe(current=current), result(current), result(current),
                                 probe(current=current), result(current)])
        self.assertEqual(self.session.step(connection, page()), 'mounted')
        first = self.sidebar_argument(self.sidebar_calls(connection)[0])
        self.assertEqual(first['projectTitle'], 'Confirmed Project')
        self.session.sidebar_project_title = 'Another Confirmed Project'
        self.assertEqual(self.session.step(connection, page()), 'mounted')
        last = self.sidebar_argument(self.sidebar_calls(connection)[-1])
        self.assertEqual(last['projectTitle'], 'Another Confirmed Project')
        self.assertEqual(last['items'], first['items'])

    def test_same_build_with_changed_revision_redefines_owned_runtime(self):
        self.session.expected_revision = 'new-revision'
        current = state(revision='new-revision')
        old = state(revision='old-revision')
        empty = state(revision='new-revision', mounted=False, roleId=None, contextKey=None)
        connection = Connection([probe(current=current), result(current), result(current),
                                 probe(current=old), result(empty), result(empty), result(current)])
        self.assertEqual(self.session.step(connection, page()), 'mounted')
        self.assertEqual(self.session.step(connection, page()), 'mounted')
        expressions = [call[1]['expression'] for call in connection.calls]
        self.assertIn('owned renderer fixture', expressions[-3])
        self.assertIn('api.configureSidebar(', expressions[-2])
        self.assertIn('api.show(', expressions[-1])


    def test_arbitrary_new_uploaded_role_uses_its_own_avatar_without_prepared_art(self):
        temporary = tempfile.TemporaryDirectory(prefix='.sidebar-custom-', dir=Path(__file__).parent)
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        registry = loader.registry_module().Registry(root / 'registry')
        self.addCleanup(registry.close)
        avatar = 'data:image/png;base64,' + base64.b64encode(TINY_PNG).decode('ascii')
        saved = registry.upsert_role({'id': 'custom-user-helper', 'name': 'My Helper',
                                     'role': 'My own job', 'avatarDataUrl': avatar}, registry.snapshot()['version'])
        saved = registry.bind('custom-user-helper', 'title', 'My explicitly confirmed chat', 'User confirmed', saved['version'])
        from backend.sidebar_assets import sidebar_items
        # No sidebar manifest or holo bundle exists in this fixture. A normal
        # new role still has its own image, irrespective of sample employee IDs.
        items = sidebar_items(saved, root / 'empty-plugin', registry)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['roleId'], 'custom-user-helper')
        self.assertEqual(items[0]['characterDataUrl'], avatar)
        self.assertEqual(items[0]['bindings'], [{'kind': 'title', 'key': 'My explicitly confirmed chat'}])
        disabled = registry.set_enabled('custom-user-helper', False, saved['version'])
        self.assertEqual(sidebar_items(disabled, root / 'empty-plugin', registry), [])

    def test_public_source_bound_holo_art_is_optional_and_role_names_do_not_choose_it(self):
        from backend import sidebar_assets
        avatar = self.registry.avatar_data('a' * 64)
        layers = {'foregroundDataUrl': 'data:image/png;base64,cHJlcGFyZWQ=',
                  'holoAssets': {'character': 'data:image/png;base64,Y2hhcmFjdGVy',
                                 'background': 'data:image/png;base64,YmFja2dyb3VuZA=='}}
        with mock.patch.object(sidebar_assets, 'display_layers', return_value=layers) as prepared:
            art = sidebar_assets.sidebar_art('a' * 64, ROOT, self.registry)
        self.assertEqual(art['characterDataUrl'], layers['holoAssets']['character'])
        self.assertEqual(prepared.call_args.args[0], 'a' * 64)
        self.assertNotEqual(art['characterDataUrl'], avatar)
        self.assertEqual(sidebar_assets.sidebar_art('not-an-image-id', ROOT, self.registry), {})

    def test_sidebar_image_memo_survives_profile_rename_and_invalidates_changed_sources(self):
        current = state()
        connection = Connection([result(current), result(current), result(current)])
        signatures = {'a' * 64: 'image-a-v1', 'b' * 64: 'image-b-v1'}
        now = [0.0]
        with mock.patch.object(loader, 'asset_signature', side_effect=lambda registry, image_id: signatures[image_id]), \
             mock.patch.object(loader.time, 'monotonic', side_effect=lambda: now[0]):
            snapshot = self.registry.snapshot()
            self.session._sync_sidebar(connection, snapshot, current)
            self.assertEqual(len(self.registry.avatar_reads), 2)
            self.session._sync_sidebar(connection, snapshot, current)
            self.assertEqual(len(self.sidebar_calls(connection)), 1)
            self.registry.edit_role('maxie', name='Updated custom display name')
            self.session._sync_sidebar(connection, self.registry.snapshot(), current)
            self.assertEqual(len(self.registry.avatar_reads), 2)
            signatures['b' * 64] = 'image-b-v2'
            now[0] = loader.ASSET_REVALIDATION_INTERVAL
            self.session._sync_sidebar(connection, self.registry.snapshot(), current)
            self.assertEqual(self.registry.avatar_reads.count('a' * 64), 1)
            self.assertEqual(self.registry.avatar_reads.count('b' * 64), 2)
        self.assertLessEqual(self.session.sidebar_asset_bytes, loader.ASSET_CACHE_BYTES)
        self.assertLessEqual(len(self.session.sidebar_assets), loader.SIDEBAR_CACHE_ITEMS)

    def test_shared_avatar_is_validated_once_and_idle_probes_do_not_rescan_materials(self):
        self.registry.roles['maxie']['imageId'] = self.registry.roles['milo']['imageId']
        current = state()
        connection = Connection([result(current)])
        now = [0.0]
        with mock.patch.object(loader, 'asset_signature', return_value='shared-source') as scans, \
             mock.patch.object(loader.time, 'monotonic', side_effect=lambda: now[0]):
            snapshot = self.registry.snapshot()
            self.session._sync_sidebar(connection, snapshot, current)
            self.assertEqual(scans.call_count, 2)  # Before and after one art read.
            self.assertEqual(len(self.registry.avatar_reads), 1)
            for tick in range(1, 8):
                now[0] = tick * loader.PROBE_INTERVAL
                self.session._sync_sidebar(connection, snapshot, current)
            self.assertEqual(scans.call_count, 2)
            self.assertEqual(len(connection.calls), 1)
            now[0] = loader.ASSET_REVALIDATION_INTERVAL
            self.session._sync_sidebar(connection, snapshot, current)
            self.assertEqual(scans.call_count, 3)
            self.assertEqual(len(self.registry.avatar_reads), 1)

    def test_maximum_legal_uploads_split_into_transport_safe_replace_and_append_batches(self):
        temporary = tempfile.TemporaryDirectory(prefix='.sidebar-large-', dir=Path(__file__).parent)
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        registry = loader.registry_module().Registry(root / 'registry')
        self.addCleanup(registry.close)
        module = loader.registry_module()
        snapshot = registry.snapshot()
        expected = {}
        for index in range(3):
            # Exercise the exact accepted binary size, rather than inventing a
            # larger data URL that the registry would reject before storage.
            raw = TINY_PNG + bytes([index]) * (module.MAX_AVATAR_BYTES - len(TINY_PNG))
            avatar = 'data:image/png;base64,' + base64.b64encode(raw).decode('ascii')
            role_id = 'custom-large-' + str(index)
            snapshot = registry.upsert_role({'id': role_id, 'name': 'Uploaded helper ' + str(index),
                                            'avatarDataUrl': avatar}, snapshot['version'])
            snapshot = registry.bind(role_id, 'title', 'Confirmed large chat ' + str(index), '', snapshot['version'])
            expected[role_id] = avatar
        session = loader.BadgeSession(registry, SCOPE, '/* fixture */', 'rev', probe='/* fixture */')
        current = state()
        connection = Connection([result(current), result(current), result(current)])
        with mock.patch.object(registry, 'avatar_data', wraps=registry.avatar_data) as reads, \
             mock.patch.object(loader, 'asset_signature', side_effect=lambda _, image_id: image_id), \
             mock.patch.object(loader.time, 'monotonic', return_value=0):
            session._sync_sidebar(connection, snapshot, current)
            self.assertEqual(reads.call_count, 3)
            session._sync_sidebar(connection, snapshot, current)
            self.assertEqual(reads.call_count, 3)
        payloads = [self.sidebar_argument(call) for call in self.sidebar_calls(connection)]
        self.assertEqual(len(payloads), 3)
        self.assertNotIn('append', payloads[0])
        self.assertTrue(all(payload.get('append') is True for payload in payloads[1:]))
        actual = {item['roleId']: item['characterDataUrl'] for payload in payloads for item in payload['items']}
        self.assertEqual(actual, expected)
        self.assertTrue(all(len(json.dumps(payload, ensure_ascii=True, separators=(',', ':')).encode('utf-8'))
                            < loader.SIDEBAR_PACKET_BYTES for payload in payloads))
        self.assertTrue(all(len(json.dumps({'id': 1, 'method': method, 'params': parameters}).encode('utf-8'))
                            < 8 * 1024 * 1024 for method, parameters in connection.calls))
        self.assertIsNotNone(session.sidebar_applied)

    def test_partial_batch_failure_restarts_with_replace_and_reuses_validated_art(self):
        current = state()
        signatures = {'a' * 64: 'image-a', 'b' * 64: 'image-b'}
        failed = Connection([result(current), OSError('owned transport fixture disconnected')])
        retry = Connection([result(current), result(current)])
        from backend import sidebar_assets
        with mock.patch.object(sidebar_assets, 'display_layers', return_value={}), \
             mock.patch.object(loader, 'SIDEBAR_PACKET_BYTES', 400), \
             mock.patch.object(loader, 'asset_signature', side_effect=lambda registry, image_id: signatures[image_id]):
            snapshot = self.registry.snapshot()
            with self.assertRaises(OSError):
                self.session._sync_sidebar(failed, snapshot, current)
            self.assertIsNone(self.session.sidebar_applied)
            self.session._sync_sidebar(retry, snapshot, current)
        self.assertEqual(len(self.registry.avatar_reads), 2)
        payloads = [self.sidebar_argument(call) for call in self.sidebar_calls(retry)]
        self.assertNotIn('append', payloads[0])
        self.assertTrue(payloads[1]['append'])
        self.assertIsNotNone(self.session.sidebar_applied)

    def test_image_memo_has_bounded_count_and_bytes(self):
        from backend import sidebar_assets
        with mock.patch.object(sidebar_assets, 'display_layers', return_value={}), \
             mock.patch.object(loader, 'asset_signature', side_effect=lambda registry, image_id: image_id), \
             mock.patch.object(loader, 'SIDEBAR_CACHE_ITEMS', 1), \
             mock.patch.object(loader, 'ASSET_CACHE_BYTES', 200):
            self.session._sidebar_art('a' * 64, 'a' * 64)
            self.session._sidebar_art('b' * 64, 'b' * 64)
        self.assertEqual(len(self.session.sidebar_assets), 1)
        self.assertGreater(self.session.sidebar_asset_bytes, 0)
        self.assertLessEqual(self.session.sidebar_asset_bytes, 200)

    def test_oversized_sidebar_item_fails_before_any_transport_write(self):
        with mock.patch.object(loader, 'SIDEBAR_PACKET_BYTES', 100):
            with self.assertRaisesRegex(ValueError, 'sidebar-item-too-large'):
                self.session._sidebar_batches([{'roleId': 'custom', 'name': 'x' * 200}])


if __name__ == '__main__':
    unittest.main()
