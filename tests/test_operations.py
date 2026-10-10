import copy
import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import timedelta
from pathlib import Path
from unittest.mock import Mock, patch

from event_crm.cli import demo, main, monitor, template, write_json
from event_crm.core import load_config, public_https, utcnow
from event_crm.store import Store
from event_crm.verification import NoRedirect, verify_https


class StateIsolationTests(unittest.TestCase):
    def test_two_initially_empty_instances_cannot_mix_events(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            config = template(demo=True)
            write_json(root / "event.json", config)
            first = Store(load_config(root / "event.json"))
            second_config = copy.deepcopy(first.config)
            second_config["event"]["name"] = "Different Synthetic Event"
            second = Store(second_config)
            sample = root / "fixture"
            demo(sample)
            snapshot = json.loads((sample / "snapshot.json").read_text())
            first.ingest(snapshot, initial=True)
            before = first.dashboard()
            with self.assertRaisesRegex(ValueError, "configuration changed"):
                second.dashboard()
            with self.assertRaisesRegex(ValueError, "configuration changed"):
                second.assign(before["audiences"][0]["records"][0]["id"], "sam", "new", "alex")
            with self.assertRaisesRegex(ValueError, "configuration changed"):
                second.ingest(snapshot, initial=True)
            self.assertEqual(before, first.dashboard())

    def test_state_parent_traversal_and_duplicate_keys_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "event.json"
            for state in ("state/..", "../elsewhere", ".", "tests"):
                config = template(demo=True)
                config["state_dir"] = state
                write_json(path, config)
                with self.assertRaises(ValueError):
                    load_config(path)
            path.write_text('{"schema_version":1,"schema_version":1}')
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                load_config(path)

    def test_public_url_syntax_rejects_local_literal_and_credentials(self):
        for value in ("https://localhost/a", "https://127.0.0.1/a", "https://10.0.0.1/a", "https://[::1]/a", "https://service.internal/a", "https://user:password@example.com/a", "javascript:alert(1)"):
            self.assertFalse(public_https(value))
        self.assertTrue(public_https("https://example.com/public-image.png"))


class MonitorTests(unittest.TestCase):
    def run_monitor(self, now, scan_offset=0, fail=False):
        config = template(demo=True)
        config["event"]["ends_at"] = (now-timedelta(seconds=1)).isoformat()
        store = Mock()
        store.dashboard.return_value = {"revision": 1}
        scan = {"captured_at": now.isoformat(), "scan_started_at": (now+timedelta(seconds=scan_offset)).isoformat()}
        store.ingest.return_value = {"revision": 2}
        clock = [now]
        def advance(seconds):
            clock[0] += timedelta(seconds=seconds)
        with patch("event_crm.cli.Store", return_value=store), patch("event_crm.cli.utcnow", side_effect=lambda: clock[0]), patch("event_crm.cli.time.sleep", side_effect=advance), patch("event_crm.providers.load_snapshot", side_effect=ValueError("synthetic source failure") if fail else None, return_value=scan), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            result = monitor(config, "synthetic.json")
        return result, store

    def test_final_requires_post_deadline_scan(self):
        result, store = self.run_monitor(utcnow(), scan_offset=-60)
        self.assertFalse(result["ok"])
        store.ingest.assert_not_called()

    def test_final_source_failure_preserves_last_good(self):
        result, store = self.run_monitor(utcnow(), fail=True)
        self.assertFalse(result["ok"])
        store.ingest.assert_not_called()

    def test_final_success(self):
        result, store = self.run_monitor(utcnow())
        self.assertEqual(result["final_scan"], "verified")
        store.ingest.assert_called_once()

    def test_final_waits_for_delayed_browser_snapshot_within_grace(self):
        now = utcnow()
        config = template(demo=True)
        config["event"]["ends_at"] = now.isoformat()
        store = Mock()
        store.dashboard.return_value = {"revision": 1}
        store.ingest.return_value = {"revision": 2}
        clock = [now]
        def advance(seconds):
            clock[0] += timedelta(seconds=seconds)
        old = {"scan_started_at": (now-timedelta(seconds=30)).isoformat(), "captured_at": now.isoformat()}
        fresh = {"scan_started_at": (now+timedelta(seconds=10)).isoformat(), "captured_at": (now+timedelta(seconds=20)).isoformat()}
        with patch("event_crm.cli.Store", return_value=store), patch("event_crm.cli.utcnow", side_effect=lambda: clock[0]), patch("event_crm.cli.time.sleep", side_effect=advance), patch("event_crm.providers.load_snapshot", side_effect=[old, fresh]) as reader, redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(monitor(config, "synthetic.json")["final_scan"], "verified")
        self.assertEqual(reader.call_count, 2)
        store.ingest.assert_called_once_with(fresh)

    def test_after_grace_does_not_fetch_or_write(self):
        config = template(demo=True)
        now = utcnow()
        config["event"]["ends_at"] = (now-timedelta(minutes=4)).isoformat()
        store = Mock()
        store.dashboard.return_value = {"revision": 1}
        with patch("event_crm.cli.Store", return_value=store), patch("event_crm.providers.fetch_luma") as fetch, patch("event_crm.cli.utcnow", return_value=now):
            self.assertFalse(monitor(config)["ok"])
        fetch.assert_not_called()
        store.ingest.assert_not_called()

    def test_final_failure_is_nonzero_cli_status(self):
        with patch("event_crm.cli.load_config", return_value=template(demo=True)), patch("event_crm.cli.monitor", return_value={"ok": False, "final_scan": "failed"}), redirect_stdout(io.StringIO()):
            self.assertEqual(main(["monitor", "--config", "synthetic.json", "--snapshot", "synthetic-snapshot.json"]), 1)


class VerificationTests(unittest.TestCase):
    def response(self, url, payload=None, cache="no-store"):
        result = Mock()
        result.__enter__ = Mock(return_value=result)
        result.__exit__ = Mock(return_value=False)
        result.geturl.return_value = url
        result.status = 200
        result.headers = {"Cache-Control": cache}
        result.read.return_value = json.dumps(payload or {}).encode()
        return result

    def test_exact_https_and_matching_payload(self):
        with tempfile.TemporaryDirectory() as folder:
            config = load_config(demo(folder)["config"])
            expected = Store(config).dashboard()
            actual = {**expected, "runtime": {"csrf": "synthetic", "access": "view"}}
            opener = Mock()
            opener.open.side_effect = [self.response("https://example.com/api/login"), self.response("https://example.com/api/dashboard", actual)]
            result = verify_https(config, "https://example.com/api/dashboard", opener=opener, token="synthetic-only")
            self.assertTrue(result["https_verified"])
            login = opener.open.call_args_list[0].args[0]
            self.assertEqual(login.get_method(), "POST")
            self.assertNotIn("synthetic-only", login.full_url)
            self.assertEqual(login.get_header("Origin"), "https://example.com")

    def test_invalid_urls_rejected_before_login(self):
        for url in ("http://example.com/api/dashboard", "https://example.com/api/dashboard?token=x", "https://example.com/wrong", "https://user:password@example.com/api/dashboard"):
            opener = Mock()
            with self.assertRaises(ValueError):
                verify_https({}, url, opener=opener, token="synthetic-only")
            opener.open.assert_not_called()

    def test_redirect_cache_and_mismatch_fail(self):
        for failure in ("redirect", "cache", "mismatch"):
            opener = Mock()
            url = "https://example.com/api/dashboard"
            opener.open.side_effect = [self.response("https://example.com/api/login"), self.response("https://example.com/elsewhere" if failure == "redirect" else url, {"revision": 2}, "public" if failure == "cache" else "no-store")]
            with patch("event_crm.verification.Store") as store:
                store.return_value.dashboard.return_value = {"revision": 1}
                with self.assertRaises(ValueError):
                    verify_https({}, url, opener=opener, token="synthetic-only")

    def test_redirect_handler_never_forwards_credentials(self):
        with self.assertRaisesRegex(ValueError, "redirects"):
            NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere.example")

    def test_published_photos_are_verified_once_per_person_not_per_audience(self):
        path = "/api/photos/" + "a"*24 + "/" + "f"*64
        expected = {"revision": 1, "captured_at": "synthetic", "audiences": [
            {"records": [{"photo_url": path}]}, {"records": [{"photo_url": path}]}]}
        image = self.response("https://example.com" + path)
        image.headers["Content-Type"] = "image/jpeg"
        image.read.return_value = b"synthetic-reviewed-bytes"
        opener = Mock()
        opener.open.side_effect = [self.response("https://example.com/api/login"), self.response("https://example.com/api/dashboard", expected), image]
        with patch("event_crm.verification.Store") as store:
            store.return_value.dashboard.return_value = expected
            store.return_value.photo.return_value = image.read.return_value
            result = verify_https({}, "https://example.com/api/dashboard", opener=opener, token="synthetic-only")
        self.assertEqual(result["photo_assets_verified"], 1)
        self.assertFalse(result["browser_render_verified"])
        self.assertEqual(opener.open.call_count, 3)

    def test_wrong_or_redirected_image_bytes_fail_publication_verification(self):
        path = "/api/photos/" + "a"*24 + "/" + "f"*64
        expected = {"revision": 1, "captured_at": "synthetic", "audiences": [{"records": [{"photo_url": path}]}]}
        for failure in ("redirect", "bytes", "mime", "cache"):
            image = self.response("https://example.com" + (path if failure != "redirect" else "/wrong"), cache="public" if failure == "cache" else "no-store")
            image.headers["Content-Type"] = "text/html" if failure == "mime" else "image/jpeg"
            image.read.return_value = b"wrong" if failure == "bytes" else b"synthetic-reviewed-bytes"
            opener = Mock()
            opener.open.side_effect = [self.response("https://example.com/api/login"), self.response("https://example.com/api/dashboard", expected), image]
            with patch("event_crm.verification.Store") as store:
                store.return_value.dashboard.return_value = expected
                store.return_value.photo.return_value = b"synthetic-reviewed-bytes"
                with self.assertRaises(ValueError):
                    verify_https({}, "https://example.com/api/dashboard", opener=opener, token="synthetic-only")


if __name__ == "__main__":
    unittest.main()
