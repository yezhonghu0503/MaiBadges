"""Small synchronous, loopback-only CDP transport (Python standard library).

Nothing connects on import or construction.  ``fetch_targets`` explicitly makes
one HTTP request; a ``CDPConnection`` connects only on entering its context.
HTTP bodies are limited to 2 MiB, WebSocket messages to 8 MiB.  Each operation
uses a deadline, including fragmented messages and intervening CDP events.
"""

import base64
import hashlib
import hmac
import http.client
import io
import json
import math
import os
import re
import socket
import struct
import threading
import time
from urllib.parse import urlsplit


__all__ = ("fetch_targets", "validate_websocket_url", "CDPConnection", "CDPError")


HTTP_LIMIT = 2 * 1024 * 1024
MESSAGE_LIMIT = 8 * 1024 * 1024
_HEADER_LIMIT = 16 * 1024
_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_PAGE_PATH = re.compile(r"/devtools/page/[A-Za-z0-9_-]+\Z")
_HEADER_NAME = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+\Z")


def _port(value):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 65535:
        raise ValueError("port must be an integer between 1 and 65535")
    return value


def _timeout(value):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or value <= 0):
        raise ValueError("timeout must be a positive finite number")
    return float(value)


def _remaining(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("CDP transport deadline exceeded")
    return remaining


def _json(text):
    def invalid_constant(_value):
        raise ValueError("non-finite JSON constant")
    return json.loads(text, parse_constant=invalid_constant)


class _DeadlineReader(io.RawIOBase):
    """HTTPResponse's buffered reader, with a deadline on every socket read.

    The caller owns and closes the socket; closing this file only closes the
    file abstraction.  This also allows HTTPResponse to handle chunked bodies.
    """

    def __init__(self, sock, deadline):
        super().__init__()
        self._sock = sock
        self._deadline = deadline

    def readable(self):
        return True

    def readinto(self, buffer):
        self._sock.settimeout(_remaining(self._deadline))
        return self._sock.recv_into(buffer)


class _HTTPFileAdapter:
    def __init__(self, sock, deadline):
        self._sock = sock
        self._deadline = deadline

    def makefile(self, mode):
        if mode != "rb":
            raise ValueError("only binary reads are supported")
        return io.BufferedReader(_DeadlineReader(self._sock, self._deadline))


def fetch_targets(port=9347, timeout=3):
    """Return the JSON list from 127.0.0.1:port/json/list, without proxies.

    All statuses other than 200, including authentication and redirects, fail.
    The timeout covers connection, headers and the complete bounded body.
    """
    port, timeout = _port(port), _timeout(timeout)
    deadline = time.monotonic() + timeout
    sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    response = None
    try:
        request = ("GET /json/list HTTP/1.1\r\n"
                   f"Host: 127.0.0.1:{port}\r\n"
                   "Accept: application/json\r\nConnection: close\r\n\r\n")
        sock.settimeout(_remaining(deadline))
        sock.sendall(request.encode("ascii"))
        response = http.client.HTTPResponse(_HTTPFileAdapter(sock, deadline))
        response.begin()
        if response.status != 200:
            raise RuntimeError(f"Target discovery refused HTTP status {response.status}")
        length = response.getheader("Content-Length")
        if length is not None:
            if not re.fullmatch(r"[0-9]+", length.strip()):
                raise RuntimeError("Invalid discovery Content-Length")
            if int(length) > HTTP_LIMIT:
                raise RuntimeError("Target discovery body exceeds 2 MiB")
        if response.getheader("Transfer-Encoding") and length is not None:
            raise RuntimeError("Ambiguous discovery response framing")
        body = response.read(HTTP_LIMIT + 1)
        if len(body) > HTTP_LIMIT:
            raise RuntimeError("Target discovery body exceeds 2 MiB")
        try:
            targets = _json(body.decode("utf-8"))
        except (UnicodeError, ValueError) as error:
            raise RuntimeError("Target discovery did not return valid UTF-8 JSON") from error
        if not isinstance(targets, list):
            raise RuntimeError("Target discovery JSON must be a list")
        return targets
    except http.client.HTTPException as error:
        raise RuntimeError("Invalid target discovery HTTP response") from error
    finally:
        if response is not None:
            response.close()
        sock.close()


def _websocket_path(url, port):
    if (not isinstance(url, str) or not url.isascii()
            or any(ord(char) <= 32 or ord(char) == 127 for char in url)):
        raise ValueError("WebSocket URL must be a plain ASCII loopback URL")
    try:
        parsed = urlsplit(url)
        valid = (parsed.scheme == "ws" and parsed.netloc == f"127.0.0.1:{port}"
                 and parsed.username is None and parsed.password is None
                 and parsed.port == port and not parsed.query and not parsed.fragment
                 and "?" not in url and "#" not in url
                 and _PAGE_PATH.fullmatch(parsed.path) is not None)
    except ValueError as error:
        raise ValueError("Invalid WebSocket URL") from error
    if not valid:
        raise ValueError(f"Only ws://127.0.0.1:{port}/devtools/page/<id> is allowed")
    return parsed.path


def validate_websocket_url(websocket_url, port=9347):
    """Validate the exact loopback/page allowlist without making a connection.

    Return the supplied URL unchanged on success; raise ValueError otherwise.
    """
    _websocket_path(websocket_url, _port(port))
    return websocket_url


class CDPError(RuntimeError):
    """A valid CDP error response; the WebSocket remains usable."""


class CDPConnection:
    """One synchronous outstanding CDP call, to one explicitly supplied page.

    Use ``with CDPConnection(url) as connection: connection.call(method, params)``.
    A protocol/IO failure closes the connection; a CDPError does not.  Contexts
    cannot be re-entered.  No redirects, authentication, extensions, compression
    or subprotocols are supported.  Server messages must be UTF-8 text.
    """

    def __init__(self, websocket_url, port=9347, timeout=8):
        self.port = _port(port)
        self.timeout = _timeout(timeout)
        self.path = _websocket_path(websocket_url, self.port)
        self._sock = None
        self._buffer = bytearray()
        self._entered = False
        self._close_sent = False
        self._next_id = 0
        self._call_lock = threading.Lock()

    def __enter__(self):
        if self._entered:
            raise RuntimeError("CDPConnection contexts cannot be re-entered")
        self._entered = True
        deadline = time.monotonic() + self.timeout
        try:
            self._sock = socket.create_connection(("127.0.0.1", self.port), timeout=self.timeout)
            self._handshake(deadline)
            return self
        except BaseException:
            self._drop()
            raise

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()
        return False

    def close(self):
        """Best-effort masked close, then unconditional socket cleanup."""
        if self._sock is None:
            return
        try:
            if not self._close_sent:
                self._send_frame(8, struct.pack("!H", 1000), time.monotonic() + min(1, self.timeout))
        except (OSError, RuntimeError):
            pass
        finally:
            self._drop()

    def _drop(self):
        sock, self._sock = self._sock, None
        self._buffer.clear()
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass

    def _send(self, data, deadline):
        if self._sock is None:
            raise RuntimeError("CDPConnection is not open")
        self._sock.settimeout(_remaining(deadline))
        self._sock.sendall(data)

    def _read_exact(self, count, deadline):
        _remaining(deadline)
        if self._sock is None:
            raise RuntimeError("CDPConnection is not open")
        result = bytearray()
        take = min(count, len(self._buffer))
        result.extend(self._buffer[:take])
        del self._buffer[:take]
        while len(result) < count:
            self._sock.settimeout(_remaining(deadline))
            chunk = self._sock.recv(min(count - len(result), 65536))
            if not chunk:
                raise RuntimeError("WebSocket connection ended unexpectedly")
            result.extend(chunk)
        return bytes(result)

    def _handshake(self, deadline):
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (f"GET {self.path} HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
                   "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self._send(request.encode("ascii"), deadline)
        while True:
            end = self._buffer.find(b"\r\n\r\n")
            if end >= 0:
                if end + 4 > _HEADER_LIMIT:
                    raise RuntimeError("WebSocket handshake headers are too large")
                raw = bytes(self._buffer[:end])
                del self._buffer[:end + 4]
                break
            if len(self._buffer) >= _HEADER_LIMIT:
                raise RuntimeError("WebSocket handshake headers are too large")
            self._sock.settimeout(_remaining(deadline))
            chunk = self._sock.recv(4096)
            if not chunk:
                raise RuntimeError("WebSocket handshake ended unexpectedly")
            self._buffer.extend(chunk)
        try:
            lines = raw.decode("ascii").split("\r\n")
        except UnicodeError as error:
            raise RuntimeError("Invalid WebSocket handshake encoding") from error
        if not re.fullmatch(r"HTTP/1\.1 101(?: [\x20-\x7e]*)?", lines[0]):
            raise RuntimeError("WebSocket upgrade refused; redirects/authentication are not followed")
        headers = {}
        for line in lines[1:]:
            if ":" not in line or line[:1] in (" ", "\t"):
                raise RuntimeError("Invalid WebSocket handshake header")
            name, value = line.split(":", 1)
            if not _HEADER_NAME.fullmatch(name) or any(ord(c) < 32 and c != "\t" or ord(c) == 127 for c in value):
                raise RuntimeError("Invalid WebSocket handshake header")
            headers.setdefault(name.lower(), []).append(value.strip())
        def tokens(name):
            return {token.strip().lower() for value in headers.get(name, []) for token in value.split(",")}
        if "websocket" not in tokens("upgrade") or "upgrade" not in tokens("connection"):
            raise RuntimeError("Missing WebSocket upgrade headers")
        expected = base64.b64encode(hashlib.sha1((key + _GUID).encode("ascii")).digest()).decode("ascii")
        accepted = headers.get("sec-websocket-accept", [])
        if len(accepted) != 1 or not hmac.compare_digest(accepted[0], expected):
            raise RuntimeError("WebSocket accept key did not match")
        if "sec-websocket-extensions" in headers or "sec-websocket-protocol" in headers:
            raise RuntimeError("Unrequested WebSocket extension or subprotocol")

    def _send_frame(self, opcode, payload, deadline):
        length = len(payload)
        if length < 126:
            header = bytes((0x80 | opcode, 0x80 | length))
        elif length <= 65535:
            header = bytes((0x80 | opcode, 0x80 | 126)) + struct.pack("!H", length)
        else:
            header = bytes((0x80 | opcode, 0x80 | 127)) + struct.pack("!Q", length)
        mask = os.urandom(4)
        if length < 256:
            masked = bytes(value ^ mask[index & 3] for index, value in enumerate(payload))
        else:
            # Translating each mask lane runs the large image payload's XOR in
            # C rather than a Python iteration for every byte. The four-byte
            # mask and wire framing remain exactly RFC 6455 compatible.
            masked = bytearray(length)
            for offset, key in enumerate(mask):
                table = bytes(value ^ key for value in range(256))
                masked[offset::4] = payload[offset::4].translate(table)
        self._send(header + mask + masked, deadline)
        if opcode == 8:
            self._close_sent = True

    def _fail(self, message, code=1002):
        try:
            if self._sock is not None and not self._close_sent:
                self._send_frame(8, struct.pack("!H", code), time.monotonic() + min(1, self.timeout))
        except (OSError, RuntimeError):
            pass
        self._drop()
        raise RuntimeError(message)

    def _read_frame(self, deadline, remaining):
        first, second = self._read_exact(2, deadline)
        fin, opcode = bool(first & 0x80), first & 0x0f
        if first & 0x70 or opcode not in (0, 1, 2, 8, 9, 10):
            self._fail("Unsupported WebSocket frame flags or opcode")
        if second & 0x80:
            self._fail("Server WebSocket frames must not be masked")
        length = second & 0x7f
        if length == 126:
            length = struct.unpack("!H", self._read_exact(2, deadline))[0]
            if length < 126:
                self._fail("Non-canonical WebSocket payload length")
        elif length == 127:
            length = struct.unpack("!Q", self._read_exact(8, deadline))[0]
            if length < 65536 or length & (1 << 63):
                self._fail("Invalid WebSocket payload length")
        if opcode >= 8:
            if not fin or length > 125:
                self._fail("Invalid fragmented or oversized WebSocket control frame")
        elif length > remaining:
            self._fail("WebSocket message exceeds 8 MiB", 1009)
        return fin, opcode, self._read_exact(length, deadline)

    def _receive_text(self, deadline):
        message, fragmented = bytearray(), False
        while True:
            fin, opcode, payload = self._read_frame(deadline, MESSAGE_LIMIT - len(message))
            if opcode == 9:
                self._send_frame(10, payload, deadline)
                continue
            if opcode == 10:
                continue
            if opcode == 8:
                if len(payload) == 1:
                    self._fail("Invalid WebSocket close payload")
                code = None
                if payload:
                    code = struct.unpack("!H", payload[:2])[0]
                    if not ((1000 <= code <= 1014 and code not in (1004, 1005, 1006)) or 3000 <= code <= 4999):
                        self._fail("Invalid WebSocket close code")
                    try:
                        payload[2:].decode("utf-8")
                    except UnicodeError:
                        self._fail("Invalid WebSocket close reason UTF-8", 1007)
                try:
                    self._send_frame(8, payload, deadline)
                finally:
                    self._drop()
                raise RuntimeError(f"WebSocket closed by peer (code={code})")
            if opcode == 2:
                self._fail("CDP expects text, not binary WebSocket messages", 1003)
            if opcode == 0:
                if not fragmented:
                    self._fail("Unexpected WebSocket continuation frame")
            elif fragmented:
                self._fail("New WebSocket data frame during a fragmented message")
            message.extend(payload)
            if fin:
                try:
                    return message.decode("utf-8")
                except UnicodeError:
                    self._fail("Invalid WebSocket text UTF-8", 1007)
            fragmented = True

    def call(self, method, params=None):
        """Send one request; ignore valid events and return its result dict.

        ``ValueError`` covers invalid local inputs; ``RuntimeError`` covers
        protocol/discovery failures; ``CDPError`` represents a remote CDP error.
        Socket errors (including ``TimeoutError``) propagate as ``OSError``.
        """
        if not isinstance(method, str) or not method or (params is not None and not isinstance(params, dict)):
            raise ValueError("method must be nonempty text and params must be a dict or None")
        if self._sock is None:
            raise RuntimeError("Use CDPConnection inside its context manager")
        if not self._call_lock.acquire(blocking=False):
            raise RuntimeError("Only one CDP call may be outstanding")
        try:
            self._next_id += 1
            request_id = self._next_id
            try:
                payload = json.dumps({"id": request_id, "method": method, "params": params or {}},
                                     ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
            except (TypeError, ValueError, UnicodeError) as error:
                raise ValueError("CDP parameters must be serialisable as UTF-8 JSON") from error
            if len(payload) > MESSAGE_LIMIT:
                raise ValueError("CDP request exceeds 8 MiB")
            deadline = time.monotonic() + self.timeout
            try:
                self._send_frame(1, payload, deadline)
                while True:
                    try:
                        response = _json(self._receive_text(deadline))
                    except ValueError as error:
                        raise RuntimeError("Invalid CDP JSON response") from error
                    if not isinstance(response, dict):
                        raise RuntimeError("CDP response must be an object")
                    if "id" not in response:
                        if not isinstance(response.get("method"), str) or not isinstance(response.get("params", {}), dict):
                            raise RuntimeError("Invalid CDP event")
                        continue
                    response_id = response["id"]
                    if isinstance(response_id, bool) or not isinstance(response_id, int) or response_id != request_id:
                        raise RuntimeError("Unexpected CDP response id")
                    if "error" in response:
                        error = response["error"]
                        if "result" in response or not isinstance(error, dict) or not isinstance(error.get("message"), str):
                            raise RuntimeError("Invalid CDP error response")
                        raise CDPError(f"CDP {method} failed ({error.get('code')}): {error['message'][:500]}")
                    if not isinstance(response.get("result"), dict):
                        raise RuntimeError("CDP result must be an object")
                    return response["result"]
            except CDPError:
                raise
            except BaseException:
                self._drop()
                raise
        finally:
            self._call_lock.release()
