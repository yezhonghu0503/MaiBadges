"""Offline transport tests. All connections are replaced by memory sockets.

No socket is bound/listened on and no browser or actual debugging port is used.
Run with: python3 -m unittest discover -s tests -p 'test_transport.py'
"""

import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import struct
import unittest
from unittest import mock


_PATH = Path(__file__).resolve().parents[1] / "transport.py"
_SPEC = importlib.util.spec_from_file_location("milo_transport_under_test", _PATH)
transport = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(transport)

_URL = "ws://127.0.0.1:9347/devtools/page/ABC-123_def"
_RANDOM = b"\x17"
_KEY = base64.b64encode(_RANDOM * 16).decode("ascii")
_ACCEPT = base64.b64encode(hashlib.sha1((_KEY + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()).decode("ascii")


class MemorySocket:
    def __init__(self, incoming=b"", chunk_size=None):
        self.incoming = bytearray(incoming)
        self.sent = []
        self.timeouts = []
        self.recv_sizes = []
        self.closed = False
        self.chunk_size = chunk_size
        self.recv_error = None
        self.send_error = None

    def settimeout(self, value):
        self.timeouts.append(value)

    def sendall(self, data):
        if self.send_error:
            raise self.send_error
        self.sent.append(bytes(data))

    def recv(self, count):
        self.recv_sizes.append(count)
        if self.recv_error:
            raise self.recv_error
        if self.chunk_size:
            count = min(count, self.chunk_size)
        result = bytes(self.incoming[:count])
        del self.incoming[:count]
        return result

    def recv_into(self, buffer):
        data = self.recv(len(buffer))
        buffer[:len(data)] = data
        return len(data)

    def close(self):
        self.closed = True


def handshake(status="101 Switching Protocols", accept=_ACCEPT, extra="",
              upgrade="websocket", connection="Upgrade"):
    return (f"HTTP/1.1 {status}\r\nUpgrade: {upgrade}\r\nConnection: {connection}\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n{extra}\r\n").encode("ascii")


def frame(payload=b"", opcode=1, fin=True, masked=False):
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    first = (0x80 if fin else 0) | opcode
    mask_bit = 0x80 if masked else 0
    length = len(payload)
    if length < 126:
        header = bytes((first, mask_bit | length))
    elif length <= 65535:
        header = bytes((first, mask_bit | 126)) + struct.pack("!H", length)
    else:
        header = bytes((first, mask_bit | 127)) + struct.pack("!Q", length)
    if masked:
        mask = b"abcd"
        return header + mask + bytes(value ^ mask[i & 3] for i, value in enumerate(payload))
    return header + payload


def result(value=None, request_id=1):
    return frame(json.dumps({"id": request_id, "result": value if value is not None else {}}, ensure_ascii=False))


def sent_frames(sock):
    """Decode already-sent client frames so tests can inspect wire properties."""
    decoded = []
    for wire in sock.sent[1:]:
        opcode, masked, length = wire[0] & 0x0f, bool(wire[1] & 0x80), wire[1] & 0x7f
        offset = 2
        if length == 126:
            length = struct.unpack("!H", wire[offset:offset + 2])[0]
            offset += 2
        elif length == 127:
            length = struct.unpack("!Q", wire[offset:offset + 8])[0]
            offset += 8
        mask = wire[offset:offset + 4] if masked else None
        offset += 4 if masked else 0
        payload = wire[offset:]
        if len(payload) != length:
            raise AssertionError("incorrect outgoing frame length")
        if mask:
            payload = bytes(value ^ mask[i & 3] for i, value in enumerate(payload))
        decoded.append((opcode, masked, payload))
    return decoded


def http_response(body, status=200, headers=None):
    if headers is None:
        headers = {"Content-Length": str(len(body))}
    return (f"HTTP/1.1 {status} Test\r\n" + "".join(f"{name}: {value}\r\n" for name, value in headers.items()) + "\r\n").encode("ascii") + body


class TransportTests(unittest.TestCase):
    def setUp(self):
        # A missed test setup can only hit this mock, never a real socket.
        self.connection_patch = mock.patch.object(transport.socket, "create_connection")
        self.connect = self.connection_patch.start()
        self.random_patch = mock.patch.object(transport.os, "urandom", side_effect=lambda count: _RANDOM * count)
        self.random_patch.start()
        self.addCleanup(self.connection_patch.stop)
        self.addCleanup(self.random_patch.stop)

    def socket_for(self, incoming=b"", chunk_size=None):
        sock = MemorySocket(incoming, chunk_size)
        self.connect.return_value = sock
        return sock

    def websocket(self, messages=b"", **kwargs):
        return self.socket_for(handshake() + messages, **kwargs)

    def test_constructor_does_not_connect(self):
        connection = transport.CDPConnection(_URL)
        self.assertEqual(transport.validate_websocket_url(_URL), _URL)
        with self.assertRaises(ValueError):
            transport.validate_websocket_url(_URL, port=9444)
        self.connect.assert_not_called()
        with self.assertRaises(RuntimeError):
            connection.call("Page.enable")

    def test_websocket_url_allowlist(self):
        forbidden = [
            "wss://127.0.0.1:9347/devtools/page/a", "http://127.0.0.1:9347/devtools/page/a",
            "ws://localhost:9347/devtools/page/a", "ws://[::1]:9347/devtools/page/a",
            "ws://127.0.0.2:9347/devtools/page/a", "ws://example.com:9347/devtools/page/a",
            "ws://127.0.0.1:9222/devtools/page/a", "ws://127.0.0.1:09347/devtools/page/a",
            "ws://user@127.0.0.1:9347/devtools/page/a", "ws://user:pass@127.0.0.1:9347/devtools/page/a",
            "ws://127.0.0.1:9347/devtools/browser/a", "ws://127.0.0.1:9347/json/list",
            "ws://127.0.0.1:9347/devtools/page/", "ws://127.0.0.1:9347/devtools/page/a/extra",
            "ws://127.0.0.1:9347/devtools/page/%2e%2e", "ws://127.0.0.1:9347/devtools/page/a?x=1",
            "ws://127.0.0.1:9347/devtools/page/a?", "ws://127.0.0.1:9347/devtools/page/a#",
            "\nws://127.0.0.1:9347/devtools/page/a", "ws://127.0.0.1:9347/devtools/page/a\r\nX: y",
        ]
        for url in forbidden:
            with self.subTest(url=url), self.assertRaises(ValueError):
                transport.CDPConnection(url)
        self.connect.assert_not_called()

    def test_invalid_port_and_timeout_do_not_connect(self):
        for port in (True, 0, 65536, "9347", 9347.0):
            with self.subTest(port=port), self.assertRaises(ValueError):
                transport.fetch_targets(port=port)
        for timeout in (False, 0, -1, float("inf"), float("nan"), "3"):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                transport.CDPConnection(_URL, timeout=timeout)
        self.connect.assert_not_called()

    def test_discovery_uses_fixed_loopback_request_and_no_proxy(self):
        sock = self.socket_for(http_response(b'[{"id":"one"}]'), chunk_size=3)
        with mock.patch.dict(transport.os.environ, {"HTTP_PROXY": "http://invalid.test:9999", "ALL_PROXY": "http://invalid.test:9999"}):
            self.assertEqual(transport.fetch_targets(), [{"id": "one"}])
        self.connect.assert_called_once_with(("127.0.0.1", 9347), timeout=3.0)
        self.assertIn(b"GET /json/list HTTP/1.1\r\nHost: 127.0.0.1:9347\r\n", sock.sent[0])
        self.assertNotIn(b"Authorization", sock.sent[0])
        self.assertTrue(sock.closed)

    def test_discovery_refuses_redirects_and_auth_without_retry(self):
        for status in (301, 302, 307, 308, 401, 407):
            with self.subTest(status=status):
                self.connect.reset_mock()
                sock = self.socket_for(http_response(b"", status=status, headers={"Location": "http://example.com/"}))
                with self.assertRaises(RuntimeError):
                    transport.fetch_targets()
                self.assertEqual(self.connect.call_count, 1)
                self.assertTrue(sock.closed)

    def test_discovery_rejects_non_list_invalid_json_and_bad_utf8(self):
        for body in (b"{}", b"not json", b"[NaN]", b"[\xff]"):
            with self.subTest(body=body):
                sock = self.socket_for(http_response(body))
                with self.assertRaises(RuntimeError):
                    transport.fetch_targets()
                self.assertTrue(sock.closed)

    def test_discovery_body_limits_declared_and_streamed(self):
        for incoming in (
                http_response(b"", headers={"Content-Length": str(transport.HTTP_LIMIT + 1)}),
                http_response(b"x" * (transport.HTTP_LIMIT + 1), headers={"Connection": "close"})):
            sock = self.socket_for(incoming)
            with self.assertRaisesRegex(RuntimeError, "2 MiB"):
                transport.fetch_targets()
            self.assertTrue(sock.closed)

    def test_discovery_accepts_chunked_body_and_rejects_ambiguous_lengths(self):
        self.socket_for(http_response(b"2\r\n[]\r\n0\r\n\r\n", headers={"Transfer-Encoding": "chunked"}))
        self.assertEqual(transport.fetch_targets(), [])
        for headers in ({"Content-Length": "2, 2"}, {"Content-Length": "-1"},
                        {"Content-Length": "2", "Transfer-Encoding": "chunked"}):
            sock = self.socket_for(http_response(b"[]", headers=headers))
            with self.assertRaises(RuntimeError):
                transport.fetch_targets()
            self.assertTrue(sock.closed)

    def test_http_read_timeout_closes_socket(self):
        sock = self.socket_for()
        sock.recv_error = socket.timeout("read timed out")
        with self.assertRaises(OSError):
            transport.fetch_targets()
        self.assertTrue(sock.closed)

    def test_http_total_deadline_expires_before_another_read(self):
        sock = self.socket_for(http_response(b"[]"))
        with mock.patch.object(transport.time, "monotonic", side_effect=[0, 0, 4]):
            with self.assertRaises(TimeoutError):
                transport.fetch_targets(timeout=3)
        self.assertTrue(sock.closed)

    def test_handshake_and_call_masking_and_context_cleanup(self):
        sock = self.websocket(result({"value": "示例"}), chunk_size=1)
        connection = transport.CDPConnection(_URL)
        with connection as cdp:
            self.assertEqual(cdp.call("Runtime.evaluate", {"expression": "1+1"}), {"value": "示例"})
        request, close = sent_frames(sock)
        self.assertEqual(request[0], 1)
        self.assertTrue(request[1])
        self.assertEqual(json.loads(request[2]), {"id": 1, "method": "Runtime.evaluate", "params": {"expression": "1+1"}})
        self.assertEqual(close, (8, True, struct.pack("!H", 1000)))
        self.assertTrue(sock.closed)
        self.assertNotIn(b"Authorization", sock.sent[0])
        with self.assertRaises(RuntimeError):
            connection.__enter__()

    def test_outgoing_mask_and_frame_boundaries_preserve_every_payload_byte(self):
        mask = b'\x00\xff\x17\x81'
        for length in (0, 1, 2, 3, 4, 5, 125, 126, 255, 256, 257, 65535, 65536, 2 * 1024 * 1024 + 3):
            with self.subTest(length=length):
                payload = (bytes(range(256)) * ((length + 255) // 256))[:length]
                sock = MemorySocket()
                sock.sent.append(b'fixture-handshake')
                connection = transport.CDPConnection(_URL)
                connection._sock = sock
                with mock.patch.object(transport.os, 'urandom', return_value=mask):
                    connection._send_frame(1, payload, transport.time.monotonic() + 10)
                self.assertEqual(sent_frames(sock), [(1, True, payload)])
                self.assertEqual(sock.sent[1][1] & 0x7f,
                                 length if length < 126 else 126 if length <= 65535 else 127)
        self.connect.assert_not_called()

    def test_large_mask_translation_handles_all_mask_byte_values(self):
        payload = bytes(range(256)) * 4 + b'odd-tail'
        for key in range(256):
            with self.subTest(key=key):
                mask = bytes((key, (key + 1) % 256, (key + 127) % 256, (key + 255) % 256))
                sock = MemorySocket()
                sock.sent.append(b'fixture-handshake')
                connection = transport.CDPConnection(_URL)
                connection._sock = sock
                with mock.patch.object(transport.os, 'urandom', return_value=mask):
                    connection._send_frame(1, payload, transport.time.monotonic() + 10)
                self.assertEqual(sent_frames(sock), [(1, True, payload)])
        self.connect.assert_not_called()

    def test_explicit_other_port_is_used_only_when_both_match(self):
        self.websocket(result())
        with transport.CDPConnection("ws://127.0.0.1:9444/devtools/page/a", port=9444) as cdp:
            self.assertEqual(cdp.call("Page.enable"), {})
        self.connect.assert_called_once_with(("127.0.0.1", 9444), timeout=8.0)

    def test_close_is_idempotent_for_manual_context_use(self):
        sock = self.websocket()
        connection = transport.CDPConnection(_URL).__enter__()
        connection.close()
        connection.close()
        self.assertEqual(sent_frames(sock), [(8, True, struct.pack("!H", 1000))])
        self.assertTrue(sock.closed)

    def test_handshake_rejections_close_socket(self):
        replies = [handshake(status="302 Found"), handshake(status="401 Unauthorized"),
                   handshake(accept="wrong"), handshake(upgrade="http"), handshake(connection="keep-alive"),
                   handshake(extra="Sec-WebSocket-Extensions: permessage-deflate\r\n"),
                   handshake(extra="Sec-WebSocket-Protocol: arbitrary\r\n"),
                   handshake(extra=f"Sec-WebSocket-Accept: {_ACCEPT}\r\n"),
                   handshake(extra=" bad-folded: value\r\n"), b"HTTP/1.1 101 OK\r\n" + b"x" * 17000]
        for reply in replies:
            with self.subTest(reply=reply[:60]):
                sock = self.socket_for(reply)
                with self.assertRaises(RuntimeError):
                    with transport.CDPConnection(_URL):
                        self.fail("bad handshake was accepted")
                self.assertTrue(sock.closed)

    def test_fragmented_utf8_with_interleaved_ping_and_pong(self):
        text = json.dumps({"id": 1, "result": {"text": "示例"}}, ensure_ascii=False).encode("utf-8")
        split = text.index("示".encode("utf-8")) + 1
        incoming = frame(text[:split], fin=False) + frame(b"hi", opcode=9) + frame(b"ignored", opcode=10) + frame(text[split:], opcode=0)
        sock = self.websocket(incoming)
        with transport.CDPConnection(_URL) as cdp:
            self.assertEqual(cdp.call("Page.enable"), {"text": "示例"})
        self.assertIn((10, True, b"hi"), sent_frames(sock))

    def test_valid_events_are_ignored_and_ids_increment(self):
        event = frame('{"method":"Page.loadEventFired","params":{"timestamp":1}}')
        sock = self.websocket(event + result({"one": 1}) + result({"two": 2}, request_id=2))
        with transport.CDPConnection(_URL) as cdp:
            self.assertEqual(cdp.call("Page.enable"), {"one": 1})
            self.assertEqual(cdp.call("Runtime.enable"), {"two": 2})
        requests = [json.loads(payload) for opcode, _, payload in sent_frames(sock) if opcode == 1]
        self.assertEqual([request["id"] for request in requests], [1, 2])

    def test_cdp_error_does_not_close_an_otherwise_valid_connection(self):
        error = frame('{"id":1,"error":{"code":-32601,"message":"Unknown method"}}')
        sock = self.websocket(error + result({"ok": True}, request_id=2))
        with transport.CDPConnection(_URL) as cdp:
            with self.assertRaisesRegex(transport.CDPError, "Unknown method"):
                cdp.call("Unknown.method")
            self.assertFalse(sock.closed)
            self.assertEqual(cdp.call("Page.enable"), {"ok": True})

    def test_invalid_cdp_messages_close_socket(self):
        payloads = ['[]', 'broken', '{"id":2,"result":{}}', '{"id":true,"result":{}}',
                    '{"id":1,"result":[]}', '{"id":1}', '{"id":1,"result":{"x":NaN}}',
                    '{"method":12}', '{"method":"x","params":[]}',
                    '{"id":1,"result":{},"error":{"message":"ambiguous"}}']
        for payload in payloads:
            with self.subTest(payload=payload):
                sock = self.websocket(frame(payload))
                with self.assertRaises(RuntimeError):
                    with transport.CDPConnection(_URL) as cdp:
                        cdp.call("Page.enable")
                self.assertTrue(sock.closed)

    def test_invalid_websocket_frames_close_socket(self):
        messages = [frame(result(), masked=True), b"\xc1\x00", b"\x83\x00",
                    frame(b"ping", opcode=9, fin=False), frame(b"x" * 126, opcode=9),
                    frame(b"orphan", opcode=0), frame(b"start", fin=False) + frame(b"new"),
                    frame(b"binary", opcode=2), frame(b"\xff"),
                    b"\x81\x7e\x00\x01x", b"\x81\x7f" + struct.pack("!Q", 1),
                    b"\x81\x7f" + struct.pack("!Q", 1 << 63)]
        for wire in messages:
            with self.subTest(wire=wire[:12]):
                sock = self.websocket(wire)
                with self.assertRaises(RuntimeError):
                    with transport.CDPConnection(_URL) as cdp:
                        cdp.call("Page.enable")
                self.assertTrue(sock.closed)

    def test_oversized_frame_rejected_before_payload_read(self):
        sock = self.websocket(b"\x81\x7f" + struct.pack("!Q", transport.MESSAGE_LIMIT + 1))
        with self.assertRaisesRegex(RuntimeError, "8 MiB"):
            with transport.CDPConnection(_URL) as cdp:
                cdp.call("Page.enable")
        self.assertIn((8, True, struct.pack("!H", 1009)), sent_frames(sock))
        self.assertLessEqual(max(sock.recv_sizes), 65536)

    def test_fragmented_aggregate_limit_is_enforced(self):
        sock = self.websocket(frame(b"a" * 40, fin=False) + frame(b"b" * 20, opcode=0))
        with mock.patch.object(transport, "MESSAGE_LIMIT", 50):
            with self.assertRaisesRegex(RuntimeError, "8 MiB"):
                with transport.CDPConnection(_URL) as cdp:
                    cdp.call("x")
        self.assertTrue(sock.closed)

    def test_server_close_is_echoed_with_mask_and_connection_is_closed(self):
        for payload in (b"", struct.pack("!H", 1000) + b"done"):
            sock = self.websocket(frame(payload, opcode=8))
            with self.assertRaisesRegex(RuntimeError, "closed by peer"):
                with transport.CDPConnection(_URL) as cdp:
                    cdp.call("Page.enable")
            self.assertIn((8, True, payload), sent_frames(sock))
            self.assertTrue(sock.closed)

    def test_invalid_server_close_payloads_are_rejected(self):
        for payload in (b"x", struct.pack("!H", 1005), struct.pack("!H", 999),
                        struct.pack("!H", 5000), struct.pack("!H", 1000) + b"\xff"):
            sock = self.websocket(frame(payload, opcode=8))
            with self.assertRaises(RuntimeError):
                with transport.CDPConnection(_URL) as cdp:
                    cdp.call("Page.enable")
            self.assertTrue(sock.closed)

    def test_extended_outgoing_lengths_are_masked_and_correct(self):
        for length, marker in ((200, 126), (70000, 127)):
            with self.subTest(length=length):
                sock = self.websocket(result())
                with transport.CDPConnection(_URL) as cdp:
                    cdp.call("Runtime.evaluate", {"expression": "x" * length})
                self.assertEqual(sock.sent[1][1] & 0x7f, marker)
                request = sent_frames(sock)[0]
                self.assertTrue(request[1])
                self.assertEqual(len(json.loads(request[2])["params"]["expression"]), length)

    def test_call_read_timeout_closes_socket(self):
        sock = self.websocket()
        with transport.CDPConnection(_URL) as cdp:
            sock.recv_error = socket.timeout("read timed out")
            with self.assertRaises(OSError):
                cdp.call("Page.enable")
            self.assertTrue(sock.closed)

    def test_call_deadline_also_covers_already_buffered_events(self):
        sock = self.websocket(result())
        with transport.CDPConnection(_URL) as cdp:
            with mock.patch.object(transport.time, "monotonic", side_effect=[0, 0, 9]):
                with self.assertRaises(TimeoutError):
                    cdp.call("Page.enable")
            self.assertTrue(sock.closed)

    def test_local_parameter_errors_do_not_send_or_close(self):
        sock = self.websocket()
        with transport.CDPConnection(_URL) as cdp:
            for method, params in (("", {}), ("x", []), ("x", {"bad": object()}),
                                   ("x", {"nan": float("nan")}), ("x", {"bad": "\ud800"})):
                with self.subTest(method=method, params=repr(params)[:40]), self.assertRaises(ValueError):
                    cdp.call(method, params)
            self.assertEqual(len(sock.sent), 1)
            self.assertFalse(sock.closed)

    def test_outgoing_limit_and_one_outstanding_call(self):
        sock = self.websocket()
        with transport.CDPConnection(_URL) as cdp:
            with mock.patch.object(transport, "MESSAGE_LIMIT", 20):
                with self.assertRaises(ValueError):
                    cdp.call("Page.enable")
            cdp._call_lock.acquire()
            try:
                with self.assertRaisesRegex(RuntimeError, "one CDP call"):
                    cdp.call("Page.enable")
            finally:
                cdp._call_lock.release()
            self.assertEqual(len(sock.sent), 1)
            self.assertFalse(sock.closed)


if __name__ == "__main__":
    unittest.main()
