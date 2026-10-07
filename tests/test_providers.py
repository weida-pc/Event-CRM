"""Offline synthetic provider contracts; no credentials or live HTTP."""

import copy
import csv
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from event_crm.providers import (
    _NoRedirect, _luma_checkin, fetch_luma, import_csv, load_snapshot,
    partiful_identity, validate_snapshot,
)


STAMP = "2000-01-01T00:00:00Z"


def config(provider="luma"):
    return {
        "event": {"provider": provider, "id": "evt-synthetic", "url": "https://luma.com/synthetic",
                  **({"calendar_id": "cal-synthetic"} if provider == "luma" else {})},
        "authorization": {"host_confirmed": True, "professional_fields_confirmed": True,
                          "team_sharing_confirmed": True},
        "fields": {"company": "Company", "title": "Role", "linkedin": "LinkedIn"},
        "questions": [{"id": "interest", "label": "Professional interests"}],
    }


def guest(source_id="guest-synthetic", name="Example Person"):
    return {"source_id": source_id, "name": name, "company": "Example Organization", "title": "Engineer",
            "linkedin_url": "https://www.linkedin.com/in/synthetic-example", "answers": {"interest": "Design"},
            "checked_in": False, "approval_status": "approved"}


def snapshot(cfg=None, guests=None):
    cfg = cfg or config()
    guests = [guest()] if guests is None else guests
    return {"schema_version": 1, "provider": cfg["event"]["provider"], "event_id": cfg["event"]["id"],
            "event_url": cfg["event"]["url"], "calendar_id": cfg["event"].get("calendar_id"),
            "scan_started_at": STAMP, "captured_at": STAMP, "complete": True,
            "source_counts": {"approved": len(guests)}, "guests": guests}


def detail():
    return {"id": "evt-synthetic", "calendar_id": "cal-synthetic", "url": "https://luma.com/synthetic",
            "access": "manage", "platform": "luma",
            "registration_questions": [
                {"id": "q-company", "label": "Company", "question_type": "text"},
                {"id": "q-role", "label": "Role", "question_type": "text"},
                {"id": "q-link", "label": "LinkedIn", "question_type": "linkedin"},
                {"id": "q-interest", "label": "Professional interests", "question_type": "select"},
                {"id": "q-unmapped", "label": "Email", "question_type": "text"}],
            "guest_counts": {status: {"guests": 1 if status == "approved" else 0, "tickets": 0}
                             for status in ("approved", "pending_approval", "waitlist", "declined", "invited")}}


def raw_guest(gid="guest-synthetic", name="Example Person"):
    return {"id": gid, "user_name": name, "approval_status": "approved",
            "user_email": "synthetic@example.invalid", "phone_number": "000-000-0000",
            "registration_answers": [
                {"question_id": "q-company", "label": "Company", "question_type": "text", "value": "Example Organization"},
                {"question_id": "q-role", "label": "Role", "question_type": "text", "value": "Engineer"},
                {"question_id": "q-link", "label": "LinkedIn", "question_type": "linkedin", "value": "https://www.linkedin.com/in/synthetic-example"},
                {"question_id": "q-interest", "label": "Professional interests", "question_type": "select", "value": "Design"},
                {"question_id": "q-unmapped", "label": "Email", "question_type": "text", "value": "synthetic@example.invalid"}],
            "event_tickets": [{"id": "ticket-" + gid, "name": name, "checked_in_at": None}]}


class Response(io.BytesIO):
    def __init__(self, data, url):
        super().__init__(json.dumps(data).encode())
        self.url = url

    def geturl(self):
        return self.url


class Opener:
    def __init__(self, responses):
        self.responses = copy.deepcopy(responses)
        self.requests = []

    def open(self, request, timeout):
        assert timeout == 30
        self.requests.append(request)
        return Response(self.responses.pop(0), request.full_url)


class SnapshotTests(unittest.TestCase):
    def test_clean_copy_and_boolean(self):
        original = snapshot()
        result = validate_snapshot(original, config())
        self.assertIsNot(result, original)
        self.assertIsNot(result["guests"][0], original["guests"][0])
        self.assertIs(result["guests"][0]["checked_in"], False)

    def test_unknown_attendance_stays_unknown(self):
        data = snapshot()
        data["guests"][0]["checked_in"] = None
        self.assertIsNone(validate_snapshot(data, config())["guests"][0]["checked_in"])

    def test_bad_boolean_is_not_coerced(self):
        for bad in ("false", "true", 0, 1, "unknown"):
            with self.subTest(bad=bad):
                data = snapshot()
                data["guests"][0]["checked_in"] = bad
                with self.assertRaises(ValueError):
                    validate_snapshot(data, config())

    def test_binding_completeness_counts_and_unknown_status(self):
        for key, bad in (("event_id", "other"), ("event_url", "https://luma.com/other"),
                         ("calendar_id", "other"), ("provider", "partiful"), ("complete", False),
                         ("source_counts", {"approved": 2}), ("captured_at", "9999-01-01T00:00:00Z")):
            with self.subTest(key=key):
                data = snapshot()
                data[key] = bad
                with self.assertRaises(ValueError):
                    validate_snapshot(data, config())
        data = snapshot()
        data["guests"][0]["approval_status"] = "maybe"
        with self.assertRaises(ValueError):
            validate_snapshot(data, config())

    def test_same_name_distinct_ids_preserved_duplicate_id_rejected(self):
        data = snapshot(guests=[guest("one"), guest("two")])
        self.assertEqual(2, len(validate_snapshot(data, config())["guests"]))
        data["guests"][1]["source_id"] = "one"
        with self.assertRaises(ValueError):
            validate_snapshot(data, config())

    def test_no_contacts_or_unmapped_answers(self):
        for key in ("email", "phone_number", "raw_payload"):
            data = snapshot()
            data["guests"][0][key] = "forbidden"
            with self.assertRaises(ValueError):
                validate_snapshot(data, config())
        data = snapshot()
        data["guests"][0]["answers"]["unmapped"] = "forbidden"
        with self.assertRaises(ValueError):
            validate_snapshot(data, config())

    def test_unsafe_questions_rejected_even_if_authorized(self):
        for label in ("Email", "Immigration status", "Visa timeline", "Phone number", "Nationality"):
            cfg = config()
            cfg["questions"] = [{"id": "extra", "label": label}]
            with self.assertRaises(ValueError):
                validate_snapshot(snapshot(), cfg)

    def test_embedded_contacts_redacted(self):
        data = snapshot()
        data["guests"][0]["answers"]["interest"] = "Design synthetic@example.invalid"
        self.assertEqual("Design [redacted]", validate_snapshot(data, config())["guests"][0]["answers"]["interest"])

    def test_partiful_identity_and_geometry(self):
        cfg = config("partiful")
        cfg["event"].update(id="synthetic", url="https://partiful.com/e/synthetic")
        row = guest()
        row["source_id"] = partiful_identity(cfg["event"]["url"], row["name"], row["linkedin_url"], row["company"])
        data = snapshot(cfg, [row])
        data["source_counts"]["cant_go"] = 0
        data["source_evidence"] = {
            "approved": {"named_count": 1, "badge_count": 3, "header_height": 30, "row_height": 50, "scroll_height": 80},
            "cant_go": {"named_count": 0, "badge_count": 0, "header_height": 30, "row_height": None, "scroll_height": 100}}
        self.assertEqual(data, validate_snapshot(data, cfg))
        data["source_evidence"]["approved"]["scroll_height"] = 81
        with self.assertRaises(ValueError):
            validate_snapshot(data, cfg)
        data.pop("source_evidence")
        data["guests"][0]["name"] = "Changed Identity"
        with self.assertRaises(ValueError):
            validate_snapshot(data, cfg)

    def test_demo_does_not_require_provider_url(self):
        cfg = config("demo")
        cfg["event"]["url"] = "https://example.invalid/synthetic"
        self.assertEqual("demo", validate_snapshot(snapshot(cfg), cfg)["provider"])

    def test_load_rejects_duplicate_json_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "snapshot.json"
            path.write_text('{"complete":true,"complete":false}', encoding="utf-8")
            with self.assertRaises(ValueError):
                load_snapshot(path, config())


class CsvTests(unittest.TestCase):
    def read(self, attendance="false", *, cfg=None, extra_rows=None, status="approved"):
        cfg = cfg or config()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic.csv"
            with path.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.writer(handle)
                writer.writerow(["source_id", "name", "Company", "Role", "LinkedIn", "Professional interests",
                                 "checked_in", "approval_status", "Email"])
                writer.writerow(["one", "Example Person", "Example Organization", "Engineer", "", "Design",
                                 attendance, status, "synthetic@example.invalid"])
                for row in extra_rows or []:
                    writer.writerow(row)
            return import_csv(path, cfg, STAMP)

    def test_strict_bool_unknown_and_contact_discard(self):
        for value, expected in (("true", True), ("false", False), ("", None), ("null", None), ("unknown", None)):
            result = self.read(value)
            self.assertIs(result["guests"][0]["checked_in"], expected)
            self.assertNotIn("Email", json.dumps(result))
            self.assertNotIn("synthetic@example.invalid", json.dumps(result))
        for value in ("1", "0", "yes", "no", "False", "checked in"):
            with self.assertRaises(ValueError):
                self.read(value)

    def test_unknown_rsvp_rejected(self):
        with self.assertRaises(ValueError):
            self.read(status="unsure")

    def test_exact_mapped_header_required(self):
        cfg = config()
        cfg["fields"]["company"] = "company"
        with self.assertRaises(ValueError):
            self.read(cfg=cfg)

    def test_unmapped_professional_fields_remain_empty(self):
        cfg = config()
        cfg["fields"] = {}
        cfg["questions"] = []
        result = self.read(cfg=cfg)["guests"][0]
        self.assertEqual(("", "", "", {}), (result["company"], result["title"], result["linkedin_url"], result["answers"]))

    def test_contact_identity_mapping_rejected(self):
        cfg = config()
        cfg["csv"] = {"name": "Email"}
        with self.assertRaises(ValueError):
            self.read(cfg=cfg)

    def test_partiful_duplicate_identity_rejected(self):
        cfg = config("partiful")
        cfg["event"].update(id="synthetic", url="https://partiful.com/e/synthetic")
        duplicate = ["two", "Example Person", "Example Organization", "Engineer", "", "Design", "true", "approved", ""]
        with self.assertRaises(ValueError):
            self.read(cfg=cfg, extra_rows=[duplicate])


class LumaTests(unittest.TestCase):
    def fetch(self, pages=None, before=None, after=None, calendar=None):
        before = before or detail()
        client = Opener([calendar or {"id": "cal-synthetic"}, before,
                         *(pages or [{"entries": [raw_guest()], "has_more": False}]), after or before])
        with patch.dict("os.environ", {"LUMA_API_KEY": "synthetic-offline-value"}):
            result = fetch_luma(config(), opener=client)
        return result, client

    def test_current_schema_readonly_and_contacts_discarded(self):
        result, client = self.fetch()
        self.assertEqual(guest(), result["guests"][0])
        self.assertNotIn("synthetic@example.invalid", json.dumps(result))
        for request in client.requests:
            self.assertEqual("GET", request.get_method())
            self.assertTrue(request.full_url.startswith("https://public-api.luma.com/v1/"))
            self.assertNotIn("synthetic-offline-value", request.full_url)
        self.assertIn("/v1/events/guests/list?", client.requests[2].full_url)

    def test_complete_pagination_and_same_name_distinct_ids(self):
        event = detail()
        event["guest_counts"]["approved"]["guests"] = 2
        pages = [{"entries": [raw_guest("one")], "has_more": True, "next_cursor": "next"},
                 {"entries": [raw_guest("two")], "has_more": False}]
        result, client = self.fetch(pages, before=event)
        self.assertEqual(2, len(result["guests"]))
        self.assertIn("pagination_cursor=next", client.requests[3].full_url)

    def test_pagination_missing_cursor_and_repeated_identity_fail(self):
        for pages in ([{"entries": [raw_guest()], "has_more": True}],
                      [{"entries": [raw_guest()], "has_more": "false"}],
                      [{"entries": [raw_guest()], "has_more": True, "next_cursor": "next"},
                       {"entries": [raw_guest()], "has_more": False}]):
            with self.assertRaises(ValueError):
                self.fetch(pages)

    def test_event_calendar_host_and_counts_fail_closed(self):
        for field, bad in (("id", "other"), ("calendar_id", "other"), ("url", "https://luma.com/other"), ("access", "view")):
            event = detail()
            event[field] = bad
            with self.assertRaises(ValueError):
                self.fetch(before=event)
        with self.assertRaises(ValueError):
            self.fetch(calendar={"id": "other"})
        event = detail()
        event["guest_counts"]["approved"]["guests"] = 2
        with self.assertRaises(ValueError):
            self.fetch(before=event)
        with self.assertRaises(ValueError):
            self.fetch(after=event)

    def test_unknown_question_type_or_changed_label_rejected(self):
        for question_type in ("phone-number", "terms", "new-type"):
            event = detail()
            event["registration_questions"][0]["question_type"] = question_type
            with self.assertRaises(ValueError):
                self.fetch(before=event)
        raw = raw_guest()
        raw["registration_answers"][0]["label"] = "changed"
        with self.assertRaises(ValueError):
            self.fetch([{"entries": [raw], "has_more": False}])

    def test_ticket_checkin_is_explicit_not_rsvp_or_join(self):
        raw = raw_guest()
        self.assertIs(_luma_checkin(raw), False)
        raw["event_tickets"][0]["checked_in_at"] = STAMP
        self.assertIs(_luma_checkin(raw), True)
        raw["event_tickets"][0].pop("checked_in_at")
        raw["joined_at"] = STAMP
        self.assertIsNone(_luma_checkin(raw))
        raw["event_tickets"] = []
        self.assertIsNone(_luma_checkin(raw))
        raw.pop("event_tickets")
        self.assertIsNone(_luma_checkin(raw))

    def test_group_is_unknown_ticket_label_is_not_an_identity_and_malformed_fails(self):
        raw = raw_guest()
        raw["event_tickets"].append({"id": "ticket-companion", "name": "Other Person", "checked_in_at": STAMP})
        self.assertIsNone(_luma_checkin(raw))
        raw["event_tickets"] = [raw["event_tickets"][1]]
        raw["event_tickets"][0]["name"] = "General Admission"
        self.assertIs(_luma_checkin(raw), True)
        raw["event_tickets"][0]["checked_in_at"] = "yesterday"
        with self.assertRaises(ValueError):
            _luma_checkin(raw)

    def test_builtin_company_object_exact_mapping(self):
        cfg, event, raw = config(), detail(), raw_guest()
        cfg["fields"]["title"] = "Company"
        event["registration_questions"][0]["question_type"] = "company"
        raw["registration_answers"][0].update(question_type="company", value={"company": "Example Organization", "job_title": "Engineer"})
        client = Opener([{"id": "cal-synthetic"}, event, {"entries": [raw], "has_more": False}, event])
        with patch.dict("os.environ", {"LUMA_API_KEY": "synthetic-offline-value"}):
            result = fetch_luma(cfg, opener=client)
        self.assertEqual("Engineer", result["guests"][0]["title"])

    def test_no_professional_questions_required_when_unmapped(self):
        cfg, event = config(), detail()
        cfg["fields"], cfg["questions"] = {}, []
        event.pop("registration_questions")
        client = Opener([{"id": "cal-synthetic"}, event, {"entries": [raw_guest()], "has_more": False}, event])
        with patch.dict("os.environ", {"LUMA_API_KEY": "synthetic-offline-value"}):
            result = fetch_luma(cfg, opener=client)
        self.assertEqual("", result["guests"][0]["company"])
        self.assertEqual({}, result["guests"][0]["answers"])

    def test_redirect_is_refused_before_following(self):
        with self.assertRaises(ValueError):
            _NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://example.invalid")


if __name__ == "__main__":
    unittest.main()
