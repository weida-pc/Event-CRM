"""Offline portrait pipeline: synthetic pixels, no real people or API calls."""
import copy
from datetime import timedelta
import hashlib
import http.client
import io
import json
import secrets
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from event_crm import photos
from event_crm.cli import demo, main
from event_crm.core import canonical, load_config, utcnow
from event_crm.server import create_server
from event_crm.store import Store

try:
    from PIL import Image, PngImagePlugin
except ImportError:
    Image = None


def synthetic_image(color="blue"):
    out = io.BytesIO()
    pixels = Image.new("RGB", (320, 240), color)
    # Synthetic geometric marks, deliberately not a generated person's face.
    for i in range(40, 180):
        pixels.putpixel((i, i), (255, 200, 0))
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("Comment", "private metadata must disappear")
    pixels.save(out, "PNG", pnginfo=metadata)
    return {"body": out.getvalue(), "content_type": "image/png", "truncated": False}


@unittest.skipIf(Image is None, 'Install ".[photos]" for image-validation tests')
class PhotoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = load_config(demo(self.temp.name)["config"])
        self.store = Store(self.config)
        self.packet = photos.plan(self.store)
        self.person = self.packet["people"][0]
        self.fetcher = Mock(return_value=synthetic_image())

    def tearDown(self):
        self.temp.cleanup()

    def candidate(self, person=None, kind="professional_profile", path="portrait.png"):
        person = person or self.person
        return {"kind": kind, "page_url": self.config["event"]["url"] if kind == "event_avatar" else "https://example.com/team/reviewed",
                "image_url": "https://images.example.com/" + path,
                "observed_name": person["name"], "observed_company": person["company"],
                "identity_basis": "Exact name and employer inspected on the professional team page.",
                "reviewer": "synthetic-reviewer", "reviewed_at": utcnow().isoformat(),
                "non_default": True, "cache_authorized": True}

    def apply_one(self):
        self.person["candidates"] = [self.candidate()]
        return photos.apply(self.store, self.packet, fetcher=self.fetcher)

    def fresh_person(self):
        packet = photos.plan(self.store)
        person = next(p for p in packet["people"] if p["id"] == self.person["id"])
        return packet, person

    def asset(self):
        person = next(p for p in photos.report(self.store)["people"] if p["id"] == self.person["id"])
        return self.store.photo(person["id"], person["digest"])

    def test_full_cohort_report_and_atomic_metadata_free_thumbnail(self):
        report = self.apply_one()
        self.assertEqual((report["tracked"], report["stored"], report["unresolved"]), (6, 1, 5))
        with Image.open(io.BytesIO(self.asset())) as image:
            self.assertEqual(image.format, "JPEG")
            self.assertEqual(image.size, (256, 192))
            self.assertNotIn("Comment", image.info)
            self.assertFalse(image.getexif())
        row = next(p for p in report["people"] if p["state"] == "stored")
        self.assertEqual(row["digest"], hashlib.sha256(self.asset()).hexdigest())
        self.assertEqual(row["evidence"]["reviewer"], "synthetic-reviewer")
        dashboard = canonical(self.store.dashboard())
        self.assertNotIn("identity_basis", dashboard)
        self.assertNotIn("images.example.com", dashboard)
        self.assertIn("/api/photos/", dashboard)

    def test_all_supported_formats_round_trip_including_nonanimated_jpeg(self):
        for mime, format_name in photos.MIME.items():
            with self.subTest(format=format_name):
                out = io.BytesIO()
                Image.new("RGB", (128, 96), "red").save(out, format_name)
                converted = photos.thumbnail({"body": out.getvalue(), "content_type": mime})
                with Image.open(io.BytesIO(converted)) as result:
                    self.assertEqual((result.format, result.size), ("JPEG", (128, 96)))

    def test_missing_pillow_is_setup_error_before_fetch_or_write(self):
        self.person["candidates"] = [self.candidate()]
        with patch("event_crm.photos._pillow", side_effect=RuntimeError("Install portrait support")):
            with self.assertRaisesRegex(RuntimeError, "Install"):
                photos.apply(self.store, self.packet, fetcher=self.fetcher)
        self.fetcher.assert_not_called()
        with self.store.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM portraits").fetchone()[0], 0)

    def test_bad_png_crc_falls_back_instead_of_aborting(self):
        corrupt = synthetic_image()
        data = bytearray(corrupt["body"])
        start = data.index(b"IDAT")
        length = int.from_bytes(data[start-4:start], "big")
        data[start + 4 + length] ^= 255
        corrupt["body"] = bytes(data)
        self.person["candidates"] = [self.candidate(kind="event_avatar"), self.candidate(kind="official_page", path="fallback.png")]
        self.fetcher.side_effect = [corrupt, synthetic_image()]
        result = photos.apply(self.store, self.packet, fetcher=self.fetcher)
        self.assertEqual(result["stored"], 1)
        self.assertEqual(self.fetcher.call_count, 2)

    def test_decoder_exif_exception_is_a_validation_failure(self):
        with patch("PIL.ImageOps.exif_transpose", side_effect=RuntimeError("bad metadata")):
            with self.assertRaisesRegex(ValueError, "decoded"):
                photos.thumbnail(synthetic_image())

    def test_photo_changes_do_not_touch_roster_assignments_or_attendance(self):
        with self.store.connect() as db:
            before = {table: [tuple(r) for r in db.execute("SELECT * FROM " + table)] for table in ("guests", "meta", "audit")}
        self.apply_one()
        with self.store.connect() as db:
            after = {table: [tuple(r) for r in db.execute("SELECT * FROM " + table)] for table in before}
        self.assertEqual(before, after)

    def test_missing_person_wrong_binding_duplicate_or_identity_refuses_before_fetch(self):
        self.person["candidates"] = [self.candidate()]
        for mutate in (lambda p: p["people"].pop(), lambda p: p.update(binding="other"),
                       lambda p: p["people"].__setitem__(1, p["people"][0]),
                       lambda p: p["people"][0].update(identity="changed")):
            packet = copy.deepcopy(self.packet)
            mutate(packet)
            with self.assertRaises(ValueError):
                photos.apply(self.store, packet, fetcher=self.fetcher)
        self.fetcher.assert_not_called()

    def test_wrong_company_name_only_default_unapproved_expired_and_paid_rejected(self):
        for changes in ({"observed_company": "Different Business"}, {"observed_name": "Someone Else"},
                        {"identity_basis": "Same name"}, {"non_default": False}, {"cache_authorized": False},
                        {"reviewed_at": (utcnow()-timedelta(days=8)).isoformat()},
                        {"kind": "paid_result"}, {"image_url": "https://127.0.0.1/photo.png"}):
            self.person["candidates"] = [{**self.candidate(), **changes}]
            with self.assertRaises(ValueError):
                photos.apply(self.store, self.packet, fetcher=self.fetcher)
        self.fetcher.assert_not_called()

    def test_fixed_fallback_order_and_empty_api_does_not_end_lookup(self):
        self.person["candidates"] = [self.candidate(kind="official_page", path="official.png"),
                                     self.candidate(kind="event_avatar", path="event.png"),
                                     self.candidate(path="profile.png")]
        self.fetcher.side_effect = [ValueError("empty source"), synthetic_image()]
        report = photos.apply(self.store, self.packet, fetcher=self.fetcher)
        self.assertEqual([c.args[0].split("/")[-1] for c in self.fetcher.call_args_list], ["event.png", "profile.png"])
        self.assertEqual(report["stored"], 1)

    def test_transient_failure_preserves_last_good_and_reports_attempt(self):
        self.apply_one()
        good = self.asset()
        packet, person = self.fresh_person()
        person.update(action="search", candidates=[self.candidate(path="refresh.png")])
        report = photos.apply(self.store, packet, fetcher=Mock(side_effect=OSError("offline")))
        self.assertEqual(good, self.asset())
        row = next(p for p in report["people"] if p["id"] == person["id"])
        self.assertEqual((row["state"], row["last_attempt"]), ("stored", "blocked"))

    def test_reject_removes_image_and_old_url_and_content_cannot_return(self):
        self.apply_one()
        old_url = next(g["photo_url"] for g in self.store.dashboard()["audiences"][0]["records"] if g["id"] == self.person["id"])
        packet, person = self.fresh_person()
        person.update(action="reject", reason="Wrong identity verified by the operator")
        photos.apply(self.store, packet, fetcher=self.fetcher)
        self.assertIsNone(self.store.photo(self.person["id"], old_url.split("/")[-1]))
        for path in ("portrait.png", "different-url-same-content.png"):
            packet, person = self.fresh_person()
            person.update(action="search", candidates=[self.candidate(path=path)])
            self.assertEqual(photos.apply(self.store, packet, fetcher=self.fetcher)["stored"], 0)

    def test_duplicate_image_across_distinct_people_is_unresolved(self):
        self.apply_one()
        packet = photos.plan(self.store)
        person = next(p for p in packet["people"] if p["id"] != self.person["id"])
        person["candidates"] = [self.candidate(person)]
        report = photos.apply(self.store, packet, fetcher=self.fetcher)
        self.assertEqual(report["stored"], 1)
        self.assertEqual(next(p for p in report["people"] if p["id"] == person["id"])["state"], "ambiguous")

    def test_same_person_across_audiences_has_one_asset_and_one_denominator(self):
        # Synthetic fixture setup only: a second audience already in the cohort.
        self.config["audiences"].append({**self.config["audiences"][0], "id": "second"})
        from event_crm.core import config_binding
        with self.store.connect() as db:
            db.execute("UPDATE meta SET value=? WHERE key='binding'", (config_binding(self.config),))
            for row in db.execute("SELECT source_id,profile FROM guests").fetchall():
                profile = json.loads(row["profile"])
                profile["audiences"].append("second")
                db.execute("UPDATE guests SET profile=? WHERE source_id=?", (canonical(profile), row["source_id"]))
        self.packet = photos.plan(self.store)
        self.person = self.packet["people"][0]
        report = self.apply_one()
        self.assertEqual(report["tracked"], 6)
        audiences = self.store.dashboard()["audiences"]
        self.assertEqual([g["photo_url"] for g in audiences[0]["records"]], [g["photo_url"] for g in audiences[1]["records"]])

    def test_changed_identity_invalidates_serving_report_and_reuse(self):
        self.apply_one()
        with self.store.connect() as db:
            db.execute("UPDATE guests SET identity='changed' WHERE alias=?", (self.person["id"],))
        self.assertIsNone(self.asset())
        self.assertFalse(any(g["photo_url"] for g in self.store.dashboard()["audiences"][0]["records"]))
        self.assertEqual(photos.report(self.store)["counts"].get("identity_changed"), 1)

    def test_stale_and_concurrent_review_refuse_overwrite(self):
        self.apply_one()
        with self.assertRaises(ValueError):
            photos.apply(self.store, self.packet, fetcher=self.fetcher)
        packet, person = self.fresh_person()
        person.update(action="search", candidates=[self.candidate(path="new.png")])
        old = self.asset()
        def concurrent(url):
            with self.store.connect() as db:
                db.execute("UPDATE portraits SET revision=revision+1")
            return synthetic_image("red")
        with self.assertRaises(ValueError):
            photos.apply(self.store, packet, fetcher=concurrent)
        self.assertEqual(old, self.asset())

    def test_not_found_needs_accounting_for_all_unpaid_sources(self):
        self.person.update(outcome="not_found", reason="No approved source yielded a portrait")
        with self.assertRaises(ValueError):
            photos.apply(self.store, self.packet, fetcher=self.fetcher)
        self.person["source_checks"] = [{"kind": kind, "result": "not_found", "reason": "Synthetic source inspected"} for kind in photos.KINDS[:3]]
        self.assertEqual(photos.apply(self.store, self.packet, fetcher=self.fetcher)["counts"]["not_found"], 1)

    def test_round_two_preserves_unresolved_accounting_and_noop_revisions(self):
        for person, outcome in zip(self.packet["people"], ("not_found", "blocked", "ambiguous", "rejected")):
            person.update(outcome=outcome, reason="Synthetic source reviewed and accounted for",
                          source_checks=[{"kind": kind, "result": "not_found", "reason": "Synthetic source inspected"} for kind in photos.KINDS[:3]])
        photos.apply(self.store, self.packet, fetcher=self.fetcher)
        with self.store.connect() as db:
            before = {r["source_id"]: tuple(r) for r in db.execute("SELECT * FROM portraits")}
        packet = photos.plan(self.store)
        self.assertEqual(packet["people"][0]["outcome"], "not_found")
        self.assertEqual(len(packet["people"][0]["source_checks"]), 3)
        person = packet["people"][-1]
        person["candidates"] = [self.candidate(person)]
        photos.apply(self.store, packet, fetcher=self.fetcher)
        with self.store.connect() as db:
            after = {r["source_id"]: tuple(r) for r in db.execute("SELECT * FROM portraits")}
        self.assertTrue(all(after[key] == value for key, value in before.items()))

    def test_reject_before_reassign_is_independent_of_alias_order(self):
        wrong = self.packet["people"][-1]
        wrong["candidates"] = [self.candidate(wrong)]
        photos.apply(self.store, self.packet, fetcher=self.fetcher)
        packet = photos.plan(self.store)
        packet["people"][-1].update(action="reject", reason="This portrait belongs to the other reviewed person")
        correct = packet["people"][0]
        correct["candidates"] = [self.candidate(correct)]
        result = photos.apply(self.store, packet, fetcher=self.fetcher)
        self.assertEqual(result["stored"], 1)
        self.assertEqual(result["people"][0]["state"], "stored")
        self.assertEqual(result["people"][-1]["state"], "rejected")

    def test_revocation_survives_resize_url_and_different_thumbnail_encoder(self):
        self.person["candidates"] = [self.candidate(path="portrait.png?w=256")]
        photos.apply(self.store, self.packet, fetcher=self.fetcher)
        packet, person = self.fresh_person()
        person.update(action="reject", reason="Reviewed wrong person")
        photos.apply(self.store, packet, fetcher=self.fetcher)
        packet, person = self.fresh_person()
        person.update(action="search", outcome="pending", candidates=[self.candidate(path="portrait.png?w=128")])
        self.fetcher.reset_mock()
        self.assertEqual(photos.apply(self.store, packet, fetcher=self.fetcher)["stored"], 0)
        self.fetcher.assert_not_called()
        packet, person = self.fresh_person()
        person.update(action="search", candidates=[self.candidate(path="another-url.png")])
        with patch("event_crm.photos.thumbnail", return_value=b"different encoder bytes"):
            self.assertEqual(photos.apply(self.store, packet, fetcher=self.fetcher)["stored"], 0)

    def test_secure_delete_enabled_on_each_database_connection(self):
        with self.store.connect() as db:
            self.assertEqual(db.execute("PRAGMA secure_delete").fetchone()[0], 1)

    def test_cli_protects_review_plan_and_accepts_bom_rejects_duplicate_keys(self):
        from contextlib import redirect_stdout, redirect_stderr
        from event_crm.cli import write_json
        config_path = self.config["_config_path"]
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(main(["photos", "--config", config_path, "--plan"]), 0)
            self.assertEqual(main(["photos", "--config", config_path, "--plan"]), 1)
            self.assertEqual(main(["photos", "--config", config_path, "--plan", "--force"]), 0)
            plan_path = self.store.directory/"photo-plan.json"
            # Synthetic file fixture: exercise common Windows editor encoding.
            plan_path.write_text(json.dumps(self.packet), encoding="utf-8-sig")
            self.assertEqual(main(["photos", "--config", config_path, "--apply"]), 0)
            plan_path.write_text('{"schema_version":1,"schema_version":1}', encoding="utf-8")
            self.assertEqual(main(["photos", "--config", config_path, "--apply"]), 1)
            write_json(plan_path, self.packet)

    def test_malformed_and_signed_hint_does_not_block_attendance(self):
        from pathlib import Path
        from event_crm.providers import validate_snapshot
        snapshot = json.loads((Path(self.temp.name)/"snapshot.json").read_text())
        for url in ("https://images.example.com/a.png?token=secret", [], "javascript:bad", "https://localhost/a"):
            snapshot["guests"][0].update(photo_url=url, photo_reviewed=True)
            clean = validate_snapshot(snapshot, self.config)
            self.assertNotIn("photo_url", clean["guests"][0])

    def test_legacy_photo_flag_and_signed_hint_are_not_approved_or_copied(self):
        with self.store.connect() as db:
            row = db.execute("SELECT source_id,profile FROM guests LIMIT 1").fetchone()
            profile = json.loads(row["profile"])
            profile["photo_url"] = "https://images.example.com/portrait.png?token=synthetic"
            db.execute("UPDATE guests SET profile=? WHERE source_id=?", (canonical(profile), row["source_id"]))
        self.assertNotIn("token=", canonical(photos.plan(self.store)))
        self.assertEqual(photos.report(self.store)["stored"], 0)
        self.assertFalse(any(g["photo_url"] for a in self.store.dashboard()["audiences"] for g in a["records"]))

    def test_cli_report_is_current_and_does_not_emit_private_names(self):
        from contextlib import redirect_stdout
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(main(["photos", "--config", self.config["_config_path"], "--plan"]), 0)
        self.assertNotIn(self.person["name"], out.getvalue())
        self.apply_one()
        with redirect_stdout(io.StringIO()):
            main(["photos", "--config", self.config["_config_path"]])
        self.assertEqual(json.loads((self.store.directory/"photo-report.json").read_text())["stored"], 1)

    def test_decode_rejects_html_mismatch_truncation_small_animated_and_oversized(self):
        candidates = [{"body": b"<html>not an image</html>", "content_type": "image/png"},
                      {**synthetic_image(), "content_type": "image/jpeg"},
                      {**synthetic_image(), "truncated": True},
                      {"body": b"x"*(photos.MAX_BYTES+1), "content_type": "image/png"}]
        for size in ((1, 1), (4096, 4096)):
            buf = io.BytesIO()
            Image.new("RGB", size).save(buf, "PNG")
            candidates.append({"body": buf.getvalue(), "content_type": "image/png"})
        buf = io.BytesIO()
        Image.new("RGB", (80, 80)).save(buf, "PNG", save_all=True, append_images=[Image.new("RGB", (80, 80), "red")])
        candidates.append({"body": buf.getvalue(), "content_type": "image/png"})
        for response in candidates:
            with self.assertRaises(ValueError):
                photos.thumbnail(response)

    def test_authenticated_http_serves_exact_cached_image_not_evidence(self):
        self.apply_one()
        token = secrets.token_urlsafe(40)
        server = create_server(self.config, port=0, store=self.store, environ={"EVENT_CRM_VIEW_TOKEN": token})
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        thread.start()
        def request(path, cookie=None, data=None):
            conn = http.client.HTTPConnection(*server.server_address, timeout=3)
            headers = {"Cookie": cookie} if cookie else {}
            if data:
                headers.update({"Content-Type": "application/json", "Origin": server.access.origin})
            conn.request("POST" if data else "GET", path, body=json.dumps(data) if data else None, headers=headers)
            response = conn.getresponse()
            result = response.status, dict(response.getheaders()), response.read()
            conn.close()
            return result
        try:
            path = next(g["photo_url"] for g in self.store.dashboard()["audiences"][0]["records"] if g["photo_url"])
            self.assertEqual(request(path)[0], 401)
            code, headers, _ = request("/api/login", data={"token": token})
            self.assertEqual(code, 200)
            cookie = headers["Set-Cookie"].split(";", 1)[0]
            code, headers, data = request(path, cookie)
            self.assertEqual((code, headers["Content-Type"]), (200, "image/jpeg"))
            self.assertEqual(data, self.asset())
            self.assertIn("no-store", headers["Cache-Control"])
            self.assertEqual(request(path[:-1] + ("0" if path[-1] != "0" else "1"), cookie)[0], 404)
            self.assertEqual(request("/api/photos/../../state.sqlite3", cookie)[0], 404)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


class PhotoTransportTests(unittest.TestCase):
    def test_url_allowlist(self):
        self.assertEqual(photos.image_url("https://images.example.com/a.png?w=128&fit=crop"), "https://images.example.com/a.png?w=128&fit=crop")
        credential_url = "https://user:password@example.com/a"  # Reserved-domain rejection fixture.
        for url in ("http://example.com/a", credential_url, "https://127.0.0.1/a", "https://[::1]/a", "https://host.local/a",
                    "https://example.com:8080/a", "https://example.com/a?token=secret", "https://example.com/a#fragment"):
            with self.assertRaises(ValueError):
                photos.image_url(url)

    def test_photo_fetch_uses_existing_pinned_transport_with_bounds(self):
        with patch("event_crm.photos._fetch_public_page") as fetch:
            photos.download("https://images.example.com/a.png")
        options = fetch.call_args.kwargs
        self.assertEqual((options["timeout"], options["max_bytes"]), (12, photos.MAX_BYTES))
        self.assertTrue(options["cross_site"])
        self.assertIs(options["validator"], photos.image_url)

    def test_dns_private_mixed_and_redirect_private_rejected(self):
        import socket
        from event_crm.research import _Deadline, _fetch_sync, _resolve_public_ips
        with patch("socket.getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]):
            with self.assertRaises(ValueError):
                _resolve_public_ips("images.example.com")
        response = Mock(status=302)
        response.getheader.side_effect = lambda name, default=None: "https://127.0.0.1/private" if name == "Location" else default
        conn = Mock()
        conn.getresponse.return_value = response
        with patch("event_crm.research._resolve_public_ips", return_value=["93.184.216.34"]), patch("event_crm.research._PinnedHTTPSConnection", return_value=conn):
            with self.assertRaises(ValueError):
                _fetch_sync("https://images.example.com/a", _Deadline(2), validator=photos.image_url,
                            max_bytes=photos.MAX_BYTES, content_types=tuple(photos.MIME), cross_site=True)
        conn.close.assert_called()
