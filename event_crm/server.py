"""Authenticated, bounded, standard-library HTTP service for the private dashboard."""

from __future__ import annotations

from collections import deque
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, HTTPServer
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
from socketserver import ThreadingMixIn
import threading
import time
from urllib.parse import urlsplit


ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/static/app.css": ("app.css", "text/css; charset=utf-8"),
    "/static/app.js": ("app.js", "text/javascript; charset=utf-8"),
}
SESSION_SECONDS = 8 * 60 * 60
MAX_BODY = 4096
MAX_SESSIONS = 256
_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{32,256}\Z")


def _json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def _invalid_constant(value):
    raise ValueError("Non-finite JSON number")


def _strong_token(token):
    if not isinstance(token, str) or not _TOKEN_RE.fullmatch(token):
        return False
    if len(set(token)) < 16:
        return False
    if any(word in token.lower() for word in ("changeme", "placeholder", "example", "password")):
        return False
    return not any(token == (token[:size] * (len(token) // size))
                   for size in range(1, len(token) // 2 + 1)
                   if len(token) % size == 0)


def _is_loopback(host):
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _utc(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.astimezone(timezone.utc) if parsed.tzinfo else None
    except (TypeError, ValueError):
        return None


class AccessConfig:
    """Validate credentials once; secrets never appear in diagnostics."""

    def __init__(self, config, host, environ):
        self.tokens = []
        view = environ.get("EVENT_CRM_VIEW_TOKEN")
        if view:
            self.tokens.append((view, None))
        try:
            team_tokens = json.loads(environ.get("EVENT_CRM_TEAM_TOKENS", "{}"), object_pairs_hook=_json_object)
        except (TypeError, ValueError) as exc:
            raise ValueError("EVENT_CRM_TEAM_TOKENS must be a JSON object") from exc
        if not isinstance(team_tokens, dict):
            raise ValueError("EVENT_CRM_TEAM_TOKENS must be a JSON object")
        member_ids = {member["id"] for member in config["team"]}
        if set(team_tokens) - member_ids:
            raise ValueError("Every team token must map to a configured team member")
        self.tokens.extend((token, actor) for actor, token in team_tokens.items())
        if not self.tokens or any(not _strong_token(token) for token, _ in self.tokens):
            raise ValueError("Set strong access tokens: generate each with secrets.token_urlsafe(32)")
        if len({token for token, _ in self.tokens}) != len(self.tokens):
            raise ValueError("Each access token must be unique")
        self.proxy = environ.get("EVENT_CRM_TRUSTED_TLS_PROXY") == "1"
        self.origin = environ.get("EVENT_CRM_PUBLIC_ORIGIN", "")
        if not _is_loopback(host) and not self.proxy:
            raise ValueError("Nonloopback binding requires explicit trusted TLS proxy mode")
        self.proxy_ips = set()
        if self.proxy:
            parsed = urlsplit(self.origin)
            if (parsed.scheme != "https" or not parsed.hostname or parsed.username
                    or parsed.password or parsed.path or parsed.query or parsed.fragment):
                raise ValueError("TLS proxy mode requires EVENT_CRM_PUBLIC_ORIGIN=https://host[:port]")
            try:
                parsed.port
                self.proxy_ips = {
                    str(ipaddress.ip_address(item.strip())) for item in
                    environ.get("EVENT_CRM_TRUSTED_PROXY_IPS", "127.0.0.1,::1").split(",")
                }
            except ValueError as exc:
                raise ValueError("Trusted proxy addresses must be explicit IP addresses") from exc
        elif self.origin:
            raise ValueError("EVENT_CRM_PUBLIC_ORIGIN requires trusted TLS proxy mode")


class DashboardServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    block_on_close = False
    allow_reuse_address = True
    request_queue_size = 32

    def __init__(self, address, config, store, access):
        self.config, self.store, self.access = config, store, access
        self.lock = threading.RLock()
        self.sessions = {}
        self.attempts = {}
        self.slots = threading.BoundedSemaphore(32)
        super().__init__(address, Handler)
        if not access.proxy:
            address_host, address_port = self.server_address[:2]
            access.origin = "http://{}:{}".format(address_host, address_port)

    def get_request(self):
        request, address = super().get_request()
        request.settimeout(10)
        return request, address

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        # Do not print request details or exception messages containing private data.
        pass


class Handler(BaseHTTPRequestHandler):
    server_version = "EventCRM"
    sys_version = ""

    def log_message(self, format, *args):
        pass

    def _reply(self, code, payload, content_type="application/json; charset=utf-8", cookie=None):
        body = payload if isinstance(payload, bytes) else json.dumps(payload, allow_nan=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, private")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; "
                         "img-src 'self' https:; connect-src 'self'; font-src 'self'; base-uri 'none'; "
                         "frame-ancestors 'none'; form-action 'self'; object-src 'none'")
        if self.server.access.proxy:
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        self.close_connection = True

    def send_error(self, code, message=None, explain=None):
        self._reply(code, {"error": HTTPStatus(code).phrase})

    def _error(self, code, message):
        self._reply(code, {"error": message})

    def _guard_request(self):
        access = self.server.access
        try:
            parsed = urlsplit(self.path)
        except ValueError:
            self._error(400, "Invalid request")
            return None
        if (parsed.scheme or parsed.netloc or parsed.query or parsed.fragment
                or not self.path.startswith("/") or "\\" in self.path):
            self._error(400, "Use an exact route without query parameters")
            return None
        expected_host = urlsplit(access.origin).netloc
        if self.headers.get_all("Host", []) != [expected_host]:
            self._error(403, "Host not allowed")
            return None
        if access.proxy:
            peer = str(ipaddress.ip_address(self.client_address[0]))
            if peer not in access.proxy_ips or self.headers.get_all("X-Forwarded-Proto", []) != ["https"]:
                self._error(403, "Trusted HTTPS proxy required")
                return None
        if self.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none"):
            self._error(403, "Cross-site requests are not allowed")
            return None
        origins = self.headers.get_all("Origin", [])
        if origins and origins != [access.origin]:
            self._error(403, "Origin not allowed")
            return None
        return parsed.path

    def _session(self):
        try:
            cookie = SimpleCookie()
            cookie.load(self.headers.get("Cookie", ""))
            key = cookie["event_crm_session"].value if "event_crm_session" in cookie else ""
        except Exception:
            key = ""
        with self.server.lock:
            session = self.server.sessions.get(key)
            if session and session["expires"] > time.monotonic():
                return key, session
            self.server.sessions.pop(key, None)
        self._error(401, "Sign in to open this private dashboard")
        return None, None

    def _runtime(self, data, session):
        now = datetime.now(timezone.utc)
        captured = _utc(data.get("captured_at"))
        ends = _utc(data.get("event", {}).get("ends_at"))
        return {
            "stale": captured is None or (now - captured).total_seconds() > self.server.config["max_age_seconds"],
            "ended": ends is not None and now > ends + timedelta(seconds=self.server.config.get("grace_seconds", 0)),
            "captured_at": data.get("captured_at"),
            "checked_at": now.isoformat(),
            "max_age_seconds": self.server.config["max_age_seconds"],
            "grace_seconds": self.server.config.get("grace_seconds", 0),
            "access": "team" if session["actor"] is not None else "read_only",
            "actor": session["actor"], "csrf": session["csrf"], "refresh_seconds": 15,
        }

    def do_GET(self):
        path = self._guard_request()
        if path is None:
            return
        if path in ASSETS:
            filename, content_type = ASSETS[path]
            self._reply(200, (Path(__file__).parent / "static" / filename).read_bytes(), content_type)
            return
        if path not in ("/api/dashboard", "/api/status"):
            self._error(404, "Route not found")
            return
        _, session = self._session()
        if session is None:
            return
        try:
            with self.server.lock:
                data = self.server.store.dashboard()
            runtime = self._runtime(data, session)
            self._reply(200, {**data, "runtime": runtime} if path == "/api/dashboard" else runtime)
        except Exception:
            self._error(503, "Dashboard temporarily unavailable; last displayed data is unchanged")

    def _body(self):
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get("Transfer-Encoding") or len(lengths) != 1:
            self._error(400, "One Content-Length is required; transfer encoding is not supported")
            return None
        try:
            length = int(lengths[0])
        except ValueError:
            self._error(400, "Invalid body length")
            return None
        if length < 0 or length > MAX_BODY:
            self._error(413, "Request body is too large")
            return None
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            self._error(415, "JSON body required")
            return None
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Incomplete body")
            body = json.loads(raw, object_pairs_hook=_json_object, parse_constant=_invalid_constant)
            if not isinstance(body, dict):
                raise ValueError("Expected object")
        except (ValueError, UnicodeDecodeError, RecursionError):
            self._error(400, "Invalid JSON body")
            return None
        return body

    def do_POST(self):
        path = self._guard_request()
        if path is None:
            return
        if path not in ("/api/login", "/api/logout", "/api/assignment"):
            self._error(405, "Method not allowed")
            return
        if self.headers.get_all("Origin", []) != [self.server.access.origin]:
            self._error(403, "Same-origin POST required")
            return
        session_key, session = (None, None)
        if path != "/api/login":
            session_key, session = self._session()
            if session is None:
                return
            csrf_values = self.headers.get_all("X-CSRF-Token", [])
            csrf = csrf_values[0] if len(csrf_values) == 1 else ""
            if not hmac.compare_digest(csrf.encode("utf-8"), session["csrf"].encode("ascii")):
                self._error(403, "Session verification failed")
                return
            if path == "/api/assignment" and session["actor"] is None:
                self._error(403, "A team member access token is required to update assignments")
                return
        body = self._body()
        if body is None:
            return
        if path == "/api/login":
            self._login(body)
        elif path == "/api/logout":
            with self.server.lock:
                self.server.sessions.pop(session_key, None)
            self._reply(200, {"ok": True}, cookie=self._cookie("", 0))
        else:
            if set(body) != {"id", "owner_id", "status"}:
                self._error(400, "Provide id, owner_id, and status only")
                return
            if (not isinstance(body["id"], str) or not body["id"] or len(body["id"]) > 128
                    or (body["owner_id"] is not None and not isinstance(body["owner_id"], str))
                    or body["owner_id"] not in {None, "", *[m["id"] for m in self.server.config["team"]]}
                    or body["status"] not in ("new", "assigned", "contacted", "follow_up", "done")):
                self._error(400, "Invalid assignment")
                return
            try:
                with self.server.lock:
                    result = self.server.store.assign(body["id"], body["owner_id"] or None, body["status"], session["actor"])
                self._reply(200, result)
            except (ValueError, KeyError):
                self._error(400, "Assignment could not be applied")
            except Exception:
                self._error(503, "Assignment temporarily unavailable")

    def _login(self, body):
        now, peer = time.monotonic(), self.client_address[0]
        with self.server.lock:
            self.server.attempts = {key: times for key, times in self.server.attempts.items()
                                    if times and times[-1] > now - 300}
            if peer not in self.server.attempts and len(self.server.attempts) >= 1024:
                self._error(429, "Sign-in temporarily limited")
                return
            attempts = self.server.attempts.setdefault(peer, deque())
            while attempts and attempts[0] <= now - 300:
                attempts.popleft()
            if len(attempts) >= 12:
                self._error(429, "Too many sign-in attempts; try again in five minutes")
                return
            attempts.append(now)
        token = body.get("token")
        if set(body) != {"token"} or not isinstance(token, str) or len(token) > 256:
            self._error(400, "Provide one token string only")
            return
        match, actor = False, None
        for expected, member in self.server.access.tokens:
            if hmac.compare_digest(token.encode("utf-8"), expected.encode("ascii")):
                match, actor = True, member
        if not match:
            self._error(401, "Access token was not accepted")
            return
        with self.server.lock:
            attempts.pop()
            self.server.sessions = {key: value for key, value in self.server.sessions.items()
                                    if value["expires"] > now}
            if len(self.server.sessions) >= MAX_SESSIONS:
                self._error(503, "Session limit reached; sign out of an existing session")
                return
            key = secrets.token_urlsafe(32)
            self.server.sessions[key] = {"actor": actor, "csrf": secrets.token_urlsafe(32), "expires": now + SESSION_SECONDS}
        self._reply(200, {"ok": True}, cookie=self._cookie(key, SESSION_SECONDS))

    def _cookie(self, value, age):
        cookie = "event_crm_session={}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}".format(value, age)
        return cookie + ("; Secure" if self.server.access.proxy else "")

    def _method_not_allowed(self):
        self._error(405, "Method not allowed")

    do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_HEAD = _method_not_allowed


def create_server(config, host="127.0.0.1", port=8765, *, store=None, environ=None):
    """Build a server without starting it; dependency injection supports offline tests."""
    access = AccessConfig(config, host, os.environ if environ is None else environ)
    if store is None:
        from event_crm.store import Store
        store = Store(config)
    return DashboardServer((host, port), config, store, access)


def serve(config, host="127.0.0.1", port=8765):
    """Serve until interrupted. Credentials and provider data are never logged."""
    with create_server(config, host, port) as server:
        try:
            server.serve_forever(poll_interval=0.5)
        except KeyboardInterrupt:
            pass
