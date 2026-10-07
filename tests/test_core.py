import copy
import json
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from event_crm.cli import demo, template
from event_crm.core import load_config, numeric_answer, rank_key, score_guest, utcnow, validate_config
from event_crm.store import Store


class ScoringTests(unittest.TestCase):
    def setUp(self):
        self.config = template(demo=True)
        self.audience = self.config["audiences"][0]

    def test_explicit_reasons_and_missing(self):
        score = score_guest({"title": "Founder", "answers": {"timing": "This quarter"}}, self.audience)
        self.assertEqual(score["score"], 60)
        self.assertEqual(len(score["reasons"]), 2)
        self.assertIn("answers.budget", score["missing_fields"])

    def test_no_match_does_not_invent_fit(self):
        self.assertEqual(score_guest({}, self.audience)["score"], 0)
        self.assertEqual(score_guest({"answers": {"timing": "Not this quarter"}}, self.audience)["score"], 0)

    def test_numeric_ranges_not_guessed(self):
        self.assertEqual(numeric_answer("$1.2M"), 1200000)
        for value in ("1-5M", "unknown", "2M+", "nan", "-100", "many", "1,23"):
            self.assertIsNone(numeric_answer(value))

    def test_low_priority_remains_last_even_checked_in(self):
        low = {"id": "a", "name": "A", "score": 100, "priority": -10, "checked_in": True}
        high = {"id": "b", "name": "B", "score": 1, "priority": 0, "checked_in": False}
        for mode in ("value_first", "attendance_first"):
            self.audience["ranking"] = mode
            self.assertLess(rank_key(high, self.audience), rank_key(low, self.audience))

    def test_modes_have_distinct_order(self):
        a = {"id": "a", "name": "A", "score": 10, "priority": 0, "checked_in": True}
        b = {"id": "b", "name": "B", "score": 90, "priority": 0, "checked_in": False}
        self.assertLess(rank_key(b, self.audience), rank_key(a, self.audience))
        self.audience["ranking"] = "attendance_first"
        self.assertLess(rank_key(a, self.audience), rank_key(b, self.audience))

    def test_reject_unapproved_and_sensitive(self):
        for mutate in (
            lambda c: c["authorization"].update(host_confirmed=False),
            lambda c: c["audiences"][0]["icp"].update(approved=False),
            lambda c: c["questions"][0].update(label="Immigration status"),
            lambda c: c["audiences"][0]["rules"][0].update(field="email"),
            lambda c: c.update(poll_seconds=1),
            lambda c: c.update(grace_seconds=181),
        ):
            config = copy.deepcopy(self.config)
            mutate(config)
            with self.assertRaises(ValueError):
                validate_config(config)

    def test_duplicate_team_and_question_ids_fail(self):
        self.config["team"].append(self.config["team"][0])
        with self.assertRaises(ValueError):
            validate_config(self.config)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        result = demo(self.root)
        self.config = load_config(result["config"])
        self.store = Store(self.config)
        self.snapshot = json.loads((self.root / "snapshot.json").read_text())

    def tearDown(self):
        self.temp.cleanup()

    def fresh(self):
        snap = copy.deepcopy(self.snapshot)
        # Fixture time is strictly later than initial and safely in the past.
        captured = utcnow() + timedelta(seconds=1)
        snap["captured_at"] = captured.isoformat()
        snap["scan_started_at"] = (captured-timedelta(seconds=1)).isoformat()
        for guest in snap["guests"]:
            guest["checked_in"] = True
        return snap, captured + timedelta(seconds=1)

    def ingest_at(self, snap, now, **kwargs):
        with patch("event_crm.store.utcnow", return_value=now), patch("event_crm.providers.datetime") as dt:
            from datetime import datetime
            dt.fromisoformat = datetime.fromisoformat
            dt.now.return_value = now
            return self.store.ingest(snap, **kwargs)

    def test_demo_works_no_keys(self):
        data = self.store.dashboard()
        self.assertEqual(len(data["audiences"][0]["records"]), 6)
        self.assertEqual(sum(r["checked_in"] is None for r in data["audiences"][0]["records"]), 1)
        self.assertNotIn("source_id", json.dumps(data))

    def test_stable_alias_assignment_and_answers_across_ingest(self):
        old = self.store.dashboard()["audiences"][0]["records"][0]
        self.store.assign(old["id"], "sam", "follow_up", "alex")
        snap, now = self.fresh()
        snap["guests"][0]["answers"]["timing"] = "Changed by provider"
        self.ingest_at(snap, now)
        record = next(r for r in self.store.dashboard()["audiences"][0]["records"] if r["id"] == old["id"])
        self.assertEqual((record["owner_id"], record["status"]), ("sam", "follow_up"))
        self.assertEqual(record["answers"], old["answers"])
        self.assertTrue(record["checked_in"])

    def test_missing_identity_unknown_and_count_fail_preserve(self):
        before = self.store.dashboard()
        for fault in ("missing", "changed", "unknown", "count"):
            snap, now = self.fresh()
            if fault == "missing":
                snap["guests"].pop()
                snap["source_counts"]["approved"] -= 1
            elif fault == "changed":
                snap["guests"][0]["company"] = "Different Company"
            elif fault == "unknown":
                snap["guests"][0]["checked_in"] = None
            else:
                snap["source_counts"]["approved"] += 1
            with self.assertRaises(ValueError):
                self.ingest_at(snap, now)
            self.assertEqual(self.store.dashboard(), before)

    def test_extra_guests_do_not_expand_cohort(self):
        snap, now = self.fresh()
        extra = copy.deepcopy(snap["guests"][0])
        extra.update(source_id="synthetic-extra", name="Extra Example")
        snap["guests"].append(extra)
        snap["source_counts"]["approved"] += 1
        self.ingest_at(snap, now)
        self.assertEqual(len(self.store.dashboard()["audiences"][0]["records"]), 6)

    def test_old_revision_and_reinitialization_refused(self):
        with self.assertRaises(ValueError):
            self.store.ingest(self.snapshot)
        snap, now = self.fresh()
        with self.assertRaises(ValueError):
            self.ingest_at(snap, now, initial=True)

    def test_end_and_start_guard(self):
        snap, now = self.fresh()
        self.config["event"]["ends_at"] = (now-timedelta(minutes=4)).isoformat()
        with self.assertRaisesRegex(ValueError, "grace period"):
            self.ingest_at(snap, now)
        self.config["event"]["ends_at"] = (now+timedelta(hours=1)).isoformat()
        self.config["event"]["starts_at"] = (now+timedelta(minutes=1)).isoformat()
        with self.assertRaisesRegex(ValueError, "not started"):
            self.ingest_at(snap, now)

    def test_config_binding_refuses_cross_event(self):
        changed = copy.deepcopy(self.config)
        changed["event"]["id"] = "another-event"
        with self.assertRaises(ValueError):
            Store(changed)

    def test_assignment_actor_status_and_unassign(self):
        alias = self.store.dashboard()["audiences"][0]["records"][0]["id"]
        for owner, status, actor in (("stranger", "new", "alex"), ("sam", "invalid", "alex"), ("sam", "new", "stranger")):
            with self.assertRaises(ValueError):
                self.store.assign(alias, owner, status, actor)
        self.assertEqual(self.store.assign(alias, None, "new", "alex")["owner_id"], "")

    def test_changed_icp_and_team_cannot_silently_change_cohort(self):
        for key in ("team", "audiences"):
            changed = copy.deepcopy(self.config)
            changed[key][0]["label"] += " changed"
            with self.assertRaises(ValueError):
                Store(changed)


if __name__ == "__main__":
    unittest.main()
