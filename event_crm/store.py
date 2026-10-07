"""Event-bound transactional state; assignments never come from provider data."""
from __future__ import annotations

import json
import secrets
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .core import canonical, config_binding, public_https, rank_key, score_guest, timestamp, utcnow


def identity(guest):
    return canonical([guest.get(k, "") for k in ("source_id", "name", "company", "linkedin_url")])


class Store:
    def __init__(self, config):
        self.config = config
        self.directory = Path(config["_state_dir"])
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.directory / "state.sqlite3"
        if self.path.is_symlink():
            raise ValueError("State database must not be a symlink")
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS guests (
                  source_id TEXT PRIMARY KEY, alias TEXT UNIQUE NOT NULL,
                  identity TEXT NOT NULL, profile TEXT NOT NULL,
                  checked_in INTEGER, owner_id TEXT NOT NULL, status TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS audit (
                  id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL,
                  alias TEXT NOT NULL, owner_id TEXT NOT NULL, status TEXT NOT NULL);
            """)
            self.assert_binding(db)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def assert_binding(self, db):
        binding = db.execute("SELECT value FROM meta WHERE key='binding'").fetchone()
        if binding and binding[0] != config_binding(self.config):
            raise ValueError("Event/cohort/scoring/team configuration changed; explicit state migration required")

    def ingest(self, snapshot, initial=False):
        from .providers import validate_snapshot
        snapshot = validate_snapshot(snapshot, self.config)
        now = utcnow()
        start, captured = timestamp(snapshot["scan_started_at"]), timestamp(snapshot["captured_at"])
        if not 0 <= (captured - start).total_seconds() <= 120:
            raise ValueError("Source scan duration exceeds 120 seconds")
        if not -15 <= (now - captured).total_seconds() <= self.config["max_age_seconds"] or (now-start).total_seconds() > self.config["max_age_seconds"]:
            raise ValueError("Snapshot is stale or future-dated")
        if (now - timestamp(self.config["event"]["ends_at"])).total_seconds() > self.config["grace_seconds"]:
            raise ValueError("Monitoring grace period ended; no writes permitted")
        if not initial:
            if now < timestamp(self.config["event"]["starts_at"]):
                raise ValueError("Monitoring has not started; use explicit initial preflight only")
        incoming = {g["source_id"]: g for g in snapshot["guests"]}
        revision = int(captured.timestamp() * 1000)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self.assert_binding(db)
            if (utcnow() - timestamp(self.config["event"]["ends_at"])).total_seconds() > self.config["grace_seconds"]:
                raise ValueError("Monitoring grace period ended; no writes permitted")
            existing = list(db.execute("SELECT * FROM guests"))
            prior = db.execute("SELECT value FROM meta WHERE key='revision'").fetchone()
            if prior and initial:
                raise ValueError("Roster already initialized; omit --initial and preserve the existing cohort")
            if prior and revision <= int(prior[0]):
                raise ValueError("Older or duplicate source revision refused")
            if existing:
                for old in existing:
                    new = incoming.get(old["source_id"])
                    if new is None or identity(new) != old["identity"]:
                        raise ValueError("Tracked identity missing or changed; last good state preserved")
                    if type(new.get("checked_in")) is not bool:
                        raise ValueError("Unknown tracked attendance; last good state preserved")
                for old in existing:
                    db.execute("UPDATE guests SET checked_in=? WHERE source_id=?", (int(incoming[old["source_id"]]["checked_in"]), old["source_id"]))
            elif not initial:
                raise ValueError("Initialize and review the roster first with --initial")
            else:
                cohort = []
                for guest in snapshot["guests"]:
                    if guest.get("approval_status") != "approved":
                        continue
                    scores = [score_guest(guest, a)["score"] for a in self.config["audiences"]]
                    if any(score >= a["min_score"] for score, a in zip(scores, self.config["audiences"])):
                        cohort.append((max(scores), guest))
                if not cohort:
                    raise ValueError("No eligible approved guests; review field mappings and ICP")
                loads = {m["id"]: 0 for m in self.config["team"]}
                for _, guest in sorted(cohort, key=lambda x: (-x[0], x[1]["source_id"])):
                    owner = min(loads, key=lambda k: (loads[k], k))
                    loads[owner] += 1
                    clean = {k: guest.get(k, "") for k in ("name", "company", "title", "linkedin_url")}
                    if not public_https(clean["linkedin_url"]):
                        clean["linkedin_url"] = ""
                    clean["answers"] = {q["id"]: guest.get("answers", {}).get(q["id"], "") for q in self.config["questions"]}
                    clean["photo_url"] = guest.get("photo_url", "") if guest.get("photo_reviewed") is True and public_https(guest.get("photo_url")) else ""
                    clean["audiences"] = [a["id"] for a in self.config["audiences"] if score_guest(guest, a)["score"] >= a["min_score"]]
                    checked = guest.get("checked_in")
                    db.execute("INSERT INTO guests VALUES (?,?,?,?,?,?,?)", (guest["source_id"], secrets.token_urlsafe(18), identity(guest), canonical(clean), None if checked is None else int(checked), owner, "new"))
                db.execute("INSERT OR REPLACE INTO meta VALUES ('binding',?)", (config_binding(self.config),))
            for key, value in (("revision", str(revision)), ("captured_at", captured.isoformat()), ("source_counts", canonical(snapshot["source_counts"]))):
                db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, value))
            counts = db.execute("SELECT COUNT(*), COALESCE(SUM(checked_in),0) FROM guests").fetchone()
        return {"matched": counts[0], "checked_in": counts[1], "revision": revision, "captured_at": captured.isoformat()}

    def dashboard(self):
        with self.connect() as db:
            db.execute("BEGIN")
            self.assert_binding(db)
            meta = dict(db.execute("SELECT key,value FROM meta"))
            guests = list(db.execute("SELECT * FROM guests"))
        audiences = []
        for audience in self.config["audiences"]:
            records = []
            for row in guests:
                profile = json.loads(row["profile"])
                if audience["id"] not in profile.pop("audiences"):
                    continue
                record = {**profile, "id": row["alias"], "checked_in": None if row["checked_in"] is None else bool(row["checked_in"]), "owner_id": row["owner_id"], "status": row["status"], **score_guest(profile, audience)}
                records.append(record)
            records.sort(key=lambda record: rank_key(record, audience))
            audiences.append({"id": audience["id"], "label": audience["label"], "ranking": audience["ranking"], "records": records})
        return {"event": {k: self.config["event"][k] for k in ("name", "provider", "starts_at", "ends_at")}, "revision": int(meta.get("revision", "0")), "captured_at": meta.get("captured_at"), "team": self.config["team"], "questions": self.config["questions"], "audiences": audiences}

    def assign(self, alias, owner_id, status, actor):
        members = {m["id"] for m in self.config["team"]}
        owner_id = owner_id or ""
        if (owner_id and owner_id not in members) or actor not in members:
            raise ValueError("Unknown team member")
        if status not in {"new", "assigned", "contacted", "follow_up", "done"}:
            raise ValueError("Unknown work status")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self.assert_binding(db)
            result = db.execute("UPDATE guests SET owner_id=?, status=? WHERE alias=?", (owner_id, status, alias))
            if result.rowcount != 1:
                raise ValueError("Unknown guest alias")
            db.execute("INSERT INTO audit(at,actor,alias,owner_id,status) VALUES (?,?,?,?,?)", (utcnow().isoformat(), actor, alias, owner_id, status))
        return {"id": alias, "owner_id": owner_id, "status": status}
