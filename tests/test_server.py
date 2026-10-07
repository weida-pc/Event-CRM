"""Offline HTTP security tests; every identity and token is synthetic."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import http.client
import json
import secrets
import tempfile
import threading
import time
import unittest

from event_crm.server import AccessConfig, create_server
from event_crm.store import AssignmentConflict


class FakeStore:
    def __init__(self):
        self.calls = []
        self.data = {
            "event": {"name": "Synthetic gathering", "provider": "demo",
                      "starts_at": datetime.now(timezone.utc).isoformat(),
                      "ends_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()},
            "revision": 1, "captured_at": datetime.now(timezone.utc).isoformat(),
            "team": [{"id": "host", "label": "Host"}],
            "questions": [{"id": "interest", "label": "Professional interest"}],
            "audiences": [{"id": "a", "label": "Audience", "ranking": "value_first", "records": [
                {"id": "guest-alias", "name": "Synthetic Person", "company": "Example Labs", "title": "Founder",
                 "linkedin_url": None, "photo_url": None, "answers": {"interest": "Research"},
                 "checked_in": None, "owner_id": None, "status": "new", "score": 20, "priority": 0,
                 "reasons": [{"rule_id": "role", "points": 20, "reason": "Professional match", "evidence": "Founder"}], "missing_fields": []}]}],
        }

    def dashboard(self):
        return deepcopy(self.data)

    def assign(self, alias, owner_id, status, actor, *, expected=None):
        if alias != "guest-alias":
            raise ValueError("Missing alias")
        current = self.data["audiences"][0]["records"][0]
        if expected != {"owner_id": current["owner_id"], "status": current["status"]}:
            raise AssignmentConflict("Synthetic stale team edit")
        self.calls.append((alias, owner_id, status, actor))
        self.data["audiences"][0]["records"][0].update(owner_id=owner_id, status=status)
        return {"id": alias, "owner_id": owner_id, "status": status}


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.config = {"team": [{"id": "host", "label": "Host"}], "max_age_seconds": 120, "grace_seconds": 0}
        self.view_token, self.team_token = secrets.token_urlsafe(40), secrets.token_urlsafe(40)
        self.env = {"EVENT_CRM_VIEW_TOKEN": self.view_token, "EVENT_CRM_TEAM_TOKENS": json.dumps({"host": self.team_token})}
        self.store = FakeStore()
        self.server = create_server(self.config, port=0, store=self.store, environ=self.env)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        self.thread.start()
        self.origin = self.server.access.origin
        self.cookie = None
        self.csrf = None

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def call(self, method, path, body=None, headers=None):
        final_headers = {}
        if self.cookie:
            final_headers["Cookie"] = self.cookie
        if body is not None:
            final_headers.update({"Content-Type": "application/json", "Origin": self.origin})
            body = json.dumps(body).encode("utf-8") if not isinstance(body, bytes) else body
        if headers:
            final_headers.update(headers)
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        connection.request(method, path, body=body, headers=final_headers)
        response = connection.getresponse()
        raw = response.read()
        result = (response.status, dict(response.getheaders()), raw)
        connection.close()
        return result

    def login(self, team=False):
        code, headers, _ = self.call("POST", "/api/login", {"token": self.team_token if team else self.view_token})
        self.assertEqual(code, 200)
        self.cookie = headers["Set-Cookie"].split(";", 1)[0]
        code, _, body = self.call("GET", "/api/status")
        self.assertEqual(code, 200)
        self.csrf = json.loads(body)["csrf"]
        return headers

    def assignment(self, **overrides):
        body = {"id": "guest-alias", "owner_id": "host", "status": "assigned",
                "expected_owner_id": None, "expected_status": "new"}
        body.update(overrides)
        return self.call("POST", "/api/assignment", body, {"X-CSRF-Token": self.csrf or ""})

    def test_dashboard_and_status_require_login(self):
        for path in ("/api/dashboard", "/api/status"):
            code, headers, body = self.call("GET", path)
            self.assertEqual(code, 401)
            self.assertNotIn(b"Synthetic Person", body)
            self.assertIn("no-store", headers["Cache-Control"])

    def test_login_cookie_and_security_headers(self):
        headers = self.login()
        cookie = headers["Set-Cookie"]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        self.assertNotIn(self.view_token, cookie)
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        code, _, body = self.call("GET", "/api/dashboard")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["runtime"]["access"], "read_only")

    def test_failed_login_never_echoes_token(self):
        token = secrets.token_urlsafe(40)
        code, headers, body = self.call("POST", "/api/login", {"token": token})
        self.assertEqual(code, 401)
        self.assertNotIn(token.encode(), body)
        self.assertNotIn("Set-Cookie", headers)

    def test_failed_login_is_rate_limited(self):
        for _ in range(12):
            self.assertEqual(self.call("POST", "/api/login", {"token": "invalid"})[0], 401)
        self.assertEqual(self.call("POST", "/api/login", {"token": self.view_token})[0], 429)

    def test_login_requires_exact_origin(self):
        for origin in ("https://elsewhere.invalid", "null", ""):
            self.assertEqual(self.call("POST", "/api/login", {"token": self.view_token}, {"Origin": origin})[0], 403)
        self.assertEqual(self.call("POST", "/api/login", b'{}', {"Sec-Fetch-Site": "cross-site"})[0], 403)

    def test_host_and_query_guards(self):
        self.assertEqual(self.call("GET", "/", headers={"Host": "attacker.invalid"})[0], 403)
        self.assertEqual(self.call("GET", "/api/dashboard?token=secret")[0], 400)
        self.assertEqual(self.call("GET", "//attacker.invalid/")[0], 404)

    def test_read_only_cannot_assign_even_with_csrf(self):
        self.login()
        self.assertEqual(self.assignment()[0], 403)
        self.assertEqual(self.store.calls, [])

    def test_team_assignment_records_authenticated_actor(self):
        self.login(team=True)
        self.assertEqual(self.assignment()[0], 200)
        self.assertEqual(self.store.calls, [("guest-alias", "host", "assigned", "host")])
        code, _, body = self.call("GET", "/api/dashboard")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body)["audiences"][0]["records"][0]["owner_id"], "host")

    def test_assignment_requires_csrf_and_does_not_accept_actor_override(self):
        self.login(team=True)
        body = {"id": "guest-alias", "owner_id": "host", "status": "assigned"}
        self.assertEqual(self.call("POST", "/api/assignment", body)[0], 403)
        self.assertEqual(self.call("POST", "/api/assignment", body, {"X-CSRF-Token": "bad"})[0], 403)
        self.assertEqual(self.assignment(actor="someone-else")[0], 400)
        self.assertEqual(self.store.calls, [])

    def test_assignment_input_types_fail_cleanly(self):
        self.login(team=True)
        for overrides in ({"id": []}, {"owner_id": []}, {"status": []}, {"owner_id": "not-on-team"}, {"status": "absent"}, {"id": "missing"}, {"expected_owner_id": []}, {"expected_status": []}):
            with self.subTest(overrides=overrides):
                self.assertEqual(self.assignment(**overrides)[0], 400)
        self.assertEqual(self.store.calls, [])

    def test_stale_assignment_returns_conflict_and_preserves_work(self):
        self.login(team=True)
        self.assertEqual(self.assignment()[0], 200)
        self.assertEqual(self.assignment(status="done")[0], 409)
        self.assertEqual(len(self.store.calls), 1)
        self.assertEqual(self.store.data["audiences"][0]["records"][0]["status"], "assigned")
        self.assertEqual(self.assignment(status="done", expected_owner_id="host", expected_status="assigned")[0], 200)

    def test_browser_assignment_requires_expected_state(self):
        self.login(team=True)
        body = {"id": "guest-alias", "owner_id": "host", "status": "assigned"}
        self.assertEqual(self.call("POST", "/api/assignment", body, {"X-CSRF-Token": self.csrf})[0], 400)
        self.assertEqual(self.store.calls, [])

    def test_logout_revokes_session(self):
        self.login(team=True)
        code, headers, _ = self.call("POST", "/api/logout", {}, {"X-CSRF-Token": self.csrf})
        self.assertEqual(code, 200)
        self.assertIn("Max-Age=0", headers["Set-Cookie"])
        self.assertEqual(self.call("GET", "/api/dashboard")[0], 401)

    def test_expired_cookie_does_not_authorize(self):
        self.login()
        key = self.cookie.split("=", 1)[1]
        self.server.sessions[key]["expires"] = time.monotonic() - 1
        self.assertEqual(self.call("GET", "/api/status")[0], 401)

    def test_methods_static_allowlist_and_no_arbitrary_files(self):
        for method in ("PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"):
            self.assertEqual(self.call(method, "/api/dashboard")[0], 405)
        for path in ("/static/app.js", "/static/app.css", "/"):
            self.assertEqual(self.call("GET", path)[0], 200)
        for path in ("/static/../server.py", "/static/%2e%2e/server.py", "/server.py", "/config.json", "/.env"):
            self.assertEqual(self.call("GET", path)[0], 404)

    def test_body_limits_and_encoding(self):
        self.assertEqual(self.call("POST", "/api/login", b"x" * 4097)[0], 413)
        self.assertEqual(self.call("POST", "/api/login", b"not json")[0], 400)
        self.assertEqual(self.call("POST", "/api/login", b"{}", {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.call("POST", "/api/login", b"{}", {"Transfer-Encoding": "chunked"})[0], 400)
        self.assertEqual(self.call("POST", "/api/login", b"[]")[0], 400)
        self.assertEqual(self.call("POST", "/api/login", b'{"token":"one","token":"two"}')[0], 400)
        self.assertEqual(self.call("POST", "/api/login", b'{"token":NaN}')[0], 400)
        self.assertEqual(self.call("POST", "/api/login", b'{"token":' + b'[' * 1000 + b']' * 1000 + b'}')[0], 400)

    def test_real_store_payload_and_assignment_survive_new_store_instance(self):
        from event_crm.cli import demo
        from event_crm.core import load_config
        from event_crm.store import Store
        with tempfile.TemporaryDirectory() as directory:
            result = demo(directory)
            config = load_config(result["config"])
            self.server.config = config
            self.server.store = Store(config)
            self.server.access.tokens = [(self.view_token, None), (self.team_token, config["team"][0]["id"])]
            self.login(team=True)
            code, _, raw = self.call("GET", "/api/dashboard")
            payload = json.loads(raw)
            payload.pop("runtime")
            self.assertEqual(code, 200)
            self.assertEqual(payload, self.server.store.dashboard())
            record = payload["audiences"][0]["records"][0]
            owner = config["team"][1]["id"]
            code, _, _ = self.assignment(id=record["id"], owner_id=owner, status="follow_up", expected_owner_id=record["owner_id"], expected_status=record["status"])
            self.assertEqual(code, 200)
            persisted = Store(config).dashboard()["audiences"][0]["records"][0]
            self.assertEqual(persisted["owner_id"], owner)
            self.assertEqual(persisted["status"], "follow_up")
            self.assertEqual(persisted["checked_in"], record["checked_in"])
            self.assertEqual(self.assignment(id=record["id"], owner_id=None, status="new", expected_owner_id=owner, expected_status="follow_up")[0], 200)
            self.assertFalse(Store(config).dashboard()["audiences"][0]["records"][0]["owner_id"])

    def test_stale_and_ended_do_not_change_attendance(self):
        self.store.data["captured_at"] = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        self.store.data["event"]["ends_at"] = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
        self.store.data["audiences"][0]["records"][0]["checked_in"] = True
        self.login()
        code, _, body = self.call("GET", "/api/dashboard")
        data = json.loads(body)
        self.assertEqual(code, 200)
        self.assertTrue(data["runtime"]["stale"])
        self.assertTrue(data["runtime"]["ended"])
        self.assertTrue(data["audiences"][0]["records"][0]["checked_in"])

    def test_store_failure_does_not_leak_details(self):
        self.login()
        def fail():
            raise ValueError("private identity and secret")
        self.store.dashboard = fail
        code, _, body = self.call("GET", "/api/dashboard")
        self.assertEqual(code, 503)
        self.assertNotIn(b"private identity", body)

    def test_weak_duplicate_and_unknown_team_credentials_rejected(self):
        invalid_environments = [
            {}, {"EVENT_CRM_VIEW_TOKEN": "weak"}, {"EVENT_CRM_VIEW_TOKEN": "a" * 64},
            {"EVENT_CRM_VIEW_TOKEN": "0123456789abcdef" * 4},
            {"EVENT_CRM_TEAM_TOKENS": "[]"},
            {"EVENT_CRM_TEAM_TOKENS": json.dumps({"stranger": self.team_token})},
            {"EVENT_CRM_VIEW_TOKEN": self.team_token, "EVENT_CRM_TEAM_TOKENS": json.dumps({"host": self.team_token})},
        ]
        for env in invalid_environments:
            with self.subTest(env_keys=list(env)):
                with self.assertRaises(ValueError):
                    AccessConfig(self.config, "127.0.0.1", env)

    def test_nonloopback_requires_explicit_valid_tls_proxy_configuration(self):
        with self.assertRaises(ValueError):
            AccessConfig(self.config, "0.0.0.0", self.env)
        for origin in ("", "http://desk.example", "https://desk.example/path", "https://user@desk.example", "https://desk.example/?q=x"):
            with self.subTest(origin=origin):
                with self.assertRaises(ValueError):
                    AccessConfig(self.config, "0.0.0.0", {**self.env, "EVENT_CRM_TRUSTED_TLS_PROXY": "1", "EVENT_CRM_PUBLIC_ORIGIN": origin})
        valid = {**self.env, "EVENT_CRM_TRUSTED_TLS_PROXY": "1", "EVENT_CRM_PUBLIC_ORIGIN": "https://desk.example"}
        access = AccessConfig(self.config, "0.0.0.0", valid)
        self.assertTrue(access.proxy)
        self.assertIn("127.0.0.1", access.proxy_ips)

    def test_proxy_requires_trusted_peer_and_forwarded_https(self):
        self.server.access.proxy = True
        self.server.access.origin = "https://desk.example"
        self.origin = "https://desk.example"
        self.server.access.proxy_ips = {"127.0.0.1"}
        headers = {"Host": "desk.example"}
        self.assertEqual(self.call("GET", "/", headers=headers)[0], 403)
        headers["X-Forwarded-Proto"] = "https"
        code, response_headers, _ = self.call("POST", "/api/login", {"token": self.view_token}, headers)
        self.assertEqual(code, 200)
        self.assertIn("; Secure", response_headers["Set-Cookie"])
        self.assertIn("Strict-Transport-Security", response_headers)
        self.server.access.proxy_ips = {"192.0.2.10"}
        self.assertEqual(self.call("GET", "/", headers=headers)[0], 403)


if __name__ == "__main__":
    unittest.main()
