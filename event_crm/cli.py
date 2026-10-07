"""Portable, agent-neutral entry point. No command sends outreach."""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from datetime import timedelta
from pathlib import Path

from .core import load_config, timestamp, utcnow
from .store import Store


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink():
        raise ValueError("Refusing a symlink output")
    fd, temporary = tempfile.mkstemp(prefix=".event-crm-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False, allow_nan=False)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def template(provider="luma", demo=False):
    now = utcnow()
    return {"schema_version": 1,
            "event": {"provider": "demo" if demo else provider, "id": "synthetic-demo" if demo else "REPLACE_EVENT_ID", "calendar_id": "REPLACE_CALENDAR_ID" if provider == "luma" and not demo else "", "url": "https://example.com/events/demo" if demo else ("https://luma.com/REPLACE_SLUG" if provider == "luma" else "https://partiful.com/e/REPLACE_EVENT_ID"), "name": "Example Growth Summit" if demo else "Your event", "starts_at": (now-timedelta(minutes=5)).isoformat(), "ends_at": (now+timedelta(hours=2)).isoformat()},
            "authorization": {"host_confirmed": demo, "professional_fields_confirmed": demo, "team_sharing_confirmed": demo},
            "state_dir": "state", "poll_seconds": 60, "max_age_seconds": 180, "grace_seconds": 180,
            "team": [{"id": "alex", "label": "Alex"}, {"id": "sam", "label": "Sam"}],
            "fields": {"company": "Company", "title": "Job title", "linkedin": "LinkedIn profile"},
            "questions": [{"id": "timing", "label": "When are you evaluating a solution?"}, {"id": "budget", "label": "Monthly business tooling budget"}, {"id": "workflow", "label": "How do you manage this workflow today?"}],
            "audiences": [{"id": "host", "label": "Host leads", "icp": {"approved": demo, "summary": "Synthetic example: operations decision makers evaluating workflow software. Replace with host-approved ICP before real use.", "sources": [{"url": "https://example.com/product", "summary": "Synthetic demonstration, not researched business evidence."}]}, "ranking": "value_first", "min_score": 0, "rules": [
                {"id": "decision_maker", "field": "title", "op": "in", "value": ["Founder", "Head of Operations"], "points": 20, "reason": "Relevant operational decision-making role"},
                {"id": "active_project", "field": "answers.timing", "op": "equals", "value": "This quarter", "points": 40, "reason": "Self-reported near-term evaluation"},
                {"id": "budget_fit", "field": "answers.budget", "op": "number_gte", "value": 1000, "points": 20, "reason": "Self-reported budget fits the example offer"},
                {"id": "not_prioritized", "field": "answers.workflow", "op": "equals", "value": "Not a priority", "points": -10, "priority": -10, "reason": "Explicitly not prioritized; keep below active opportunities"}]}]}


def demo(directory):
    directory = Path(directory)
    config_path = directory / "event.json"
    if config_path.exists():
        config = load_config(config_path)
        if config["event"]["provider"] != "demo":
            raise ValueError("Demo refuses an existing real-event configuration")
        return {"config": str(config_path.absolute()), "message": "Existing demo preserved; use serve or a new explicit directory"}
    config = template(demo=True)
    write_json(config_path, config)
    config = load_config(config_path)
    rows = [
        ("Avery Example", "Sample Analytics", "Founder", "This quarter", "5000", "Internal team", True),
        ("Jordan Example", "Demo Logistics", "Head of Operations", "This quarter", "2500", "Spreadsheet", False),
        ("Morgan Example", "Sample Studio", "Founder", "Next year", "500", "Not a priority", True),
        ("Riley Example", "Demo Systems", "Engineer", "Exploring", "", "Spreadsheet", None),
        ("Taylor Example", "Sample Works", "Founder", "This quarter", "1200", "Agency", False),
        ("Casey Example", "Demo Research", "Analyst", "", "", "", False),
    ]
    now = utcnow().isoformat()
    snapshot = {"schema_version": 1, "provider": "demo", "event_id": config["event"]["id"], "event_url": config["event"]["url"], "calendar_id": "", "scan_started_at": now, "captured_at": now, "complete": True, "source_counts": {"approved": len(rows)}, "guests": [
        {"source_id": f"synthetic-{i}", "name": row[0], "company": row[1], "title": row[2], "linkedin_url": "", "answers": dict(zip(("timing", "budget", "workflow"), row[3:6])), "checked_in": row[6], "approval_status": "approved"} for i, row in enumerate(rows)]}
    write_json(directory / "snapshot.json", snapshot)
    result = Store(config).ingest(snapshot, initial=True)
    return {**result, "config": str(config_path.absolute()), "synthetic_only": True}


def monitor(config, snapshot_path=None):
    from .providers import fetch_luma, load_snapshot
    store = Store(config)
    if not store.dashboard()["revision"]:
        raise ValueError("Initialize and inspect the roster before starting monitoring")
    event = config["event"]
    end = timestamp(event["ends_at"])
    grace_end = end + timedelta(seconds=config["grace_seconds"])
    while True:
        now = utcnow()
        if now > grace_end:
            return {"ok": False, "monitor": "ended", "final_scan": "grace_expired_no_write"}
        if now < timestamp(event["starts_at"]):
            time.sleep(min(60, max(0.1, (timestamp(event["starts_at"])-now).total_seconds())))
            continue
        final = now >= end
        try:
            snapshot = load_snapshot(snapshot_path, config) if snapshot_path else fetch_luma(config)
            if final and timestamp(snapshot["scan_started_at"]) < end:
                raise ValueError("Final run requires a new source scan after the monitoring deadline")
            old = store.dashboard()
            if int(timestamp(snapshot["captured_at"]).timestamp()*1000) > old["revision"]:
                result = store.ingest(snapshot)
                print(json.dumps({"ok": True, **result}), flush=True)
            elif (now-timestamp(snapshot["captured_at"])).total_seconds() > config["max_age_seconds"]:
                raise ValueError("Browser snapshot is stale; authorized browser agent must supply a fresh scan")
            elif final:
                raise ValueError("Final run requires a new source scan after the monitoring deadline")
        except (ValueError, OSError, RuntimeError) as exc:
            print(json.dumps({"ok": False, "error": str(exc), "last_good_preserved": True}), file=sys.stderr, flush=True)
            if final:
                return {"ok": False, "monitor": "ended", "final_scan": "failed_last_good_preserved"}
        if final:
            return {"monitor": "ended", "final_scan": "verified"}
        time.sleep(max(0.1, min(config["poll_seconds"], (end-utcnow()).total_seconds())))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Event CRM — private event lead prioritization and team coordination")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("demo", help="Create a synthetic, credential-free demo")
    p.add_argument("--directory", default="runtime/demo")
    p = sub.add_parser("init", help="Create an unapproved onboarding template; no provider contact")
    p.add_argument("--directory", required=True)
    p.add_argument("--provider", choices=["luma", "partiful"], required=True)
    p = sub.add_parser("research", help="Research public host business website; never transmit full email")
    p.add_argument("--email")
    p.add_argument("--website")
    p.add_argument("--output", required=True)
    for command in ("doctor", "sync", "ingest", "import-csv", "serve", "monitor", "verify", "assign"):
        p = sub.add_parser(command)
        p.add_argument("--config", required=True)
        if command in {"sync", "ingest", "import-csv"}:
            p.add_argument("--initial", action="store_true")
        if command in {"ingest", "monitor"}:
            p.add_argument("--snapshot", required=command == "ingest")
        if command == "import-csv":
            p.add_argument("--csv", required=True)
            p.add_argument("--captured-at", required=True, help="Actual export timestamp with timezone, never file modification time")
        if command == "serve":
            p.add_argument("--host", default="127.0.0.1")
            p.add_argument("--port", type=int, default=8765)
        if command == "verify":
            p.add_argument("--url", help="Exact HTTPS /api/dashboard URL to compare, view credential via EVENT_CRM_VERIFY_TOKEN")
        if command == "assign":
            for name in ("id", "owner", "status", "actor"):
                p.add_argument("--"+name, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "demo":
            result = demo(args.directory)
        elif args.command == "init":
            path = Path(args.directory) / "event.json"
            if path.exists():
                raise ValueError("Configuration already exists; edit it in place")
            write_json(path, template(args.provider))
            result = {"config": str(path.absolute()), "ready": False, "next": "Follow START_HERE.md; template is deliberately unapproved"}
        elif args.command == "research":
            from .research import research_host
            if not args.email and not args.website:
                raise ValueError("Provide --email or --website")
            packet = research_host(args.email, args.website)
            write_json(args.output, packet)
            result = {"output": str(Path(args.output).absolute()), "approval_required": True, "sources": len(packet["sources"])}
        else:
            config = load_config(args.config)
            if args.command == "doctor":
                key_needed = config["event"]["provider"] == "luma"
                result = {"configuration_valid": True, "provider": config["event"]["provider"], "luma_key_present": bool(os.environ.get("LUMA_API_KEY")) if key_needed else "not_required", "view_token_present": bool(os.environ.get("EVENT_CRM_VIEW_TOKEN")), "team_tokens_present": bool(os.environ.get("EVENT_CRM_TEAM_TOKENS")), "browser_required": config["event"]["provider"] == "partiful", "provider_access_tested": False}
            elif args.command == "serve":
                from .server import serve
                serve(config, host=args.host, port=args.port)
                return 0
            elif args.command == "monitor":
                if config["event"]["provider"] != "luma" and not args.snapshot:
                    raise ValueError("Partiful needs --snapshot supplied by an authorized browser agent; this process does not control a browser")
                result = monitor(config, args.snapshot)
            elif args.command == "assign":
                result = Store(config).assign(args.id, args.owner, args.status, args.actor)
            elif args.command == "verify":
                if args.url:
                    from .verification import verify_https
                    result = verify_https(config, args.url)
                else:
                    data = Store(config).dashboard()
                    result = {"revision": data["revision"], "captured_at": data["captured_at"], "audiences": {a["id"]: {"leads": len(a["records"]), "checked_in": sum(r["checked_in"] is True for r in a["records"]), "unknown": sum(r["checked_in"] is None for r in a["records"])} for a in data["audiences"]}}
            else:
                from .providers import fetch_luma, import_csv, load_snapshot
                if args.command == "sync":
                    if config["event"]["provider"] != "luma":
                        raise ValueError("sync is Luma API only; Partiful uses an authorized browser snapshot")
                    snapshot = fetch_luma(config)
                elif args.command == "import-csv":
                    snapshot = import_csv(args.csv, config, args.captured_at)
                else:
                    snapshot = load_snapshot(args.snapshot, config)
                result = Store(config).ingest(snapshot, initial=args.initial)
        print(json.dumps({"ok": True, **result}, ensure_ascii=False))
        return 0 if result.get("ok", True) else 1
    except (ValueError, OSError, RuntimeError, KeyError, TypeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
