"""Strict configuration and transparent, deterministic commercial-fit scoring."""
from __future__ import annotations

import hashlib
import ipaddress
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

IDENTIFIER = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
SENSITIVE = re.compile(r"email|e-mail|phone|mobile|address|immigration|citizenship|visa|passport|race|ethnicity|religion|gender|sexual|disability|medical|health|social.security|birth|ssn", re.I)
OPS = {"equals", "contains", "in", "number_gte", "number_lte"}


def utcnow():
    return datetime.now(timezone.utc)


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("Timestamp must be an ISO 8601 string with timezone")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("Invalid ISO 8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise ValueError("Timestamp requires an explicit timezone offset")
    return parsed.astimezone(timezone.utc)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def identifier(value):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ValueError("IDs must start with a lowercase letter and contain only letters, numbers, _ or -")
    return value


def public_https(value):
    if not isinstance(value, str):
        return False
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ""
        try:
            address = ipaddress.ip_address(host)
            host_ok = address.is_global and not address.is_multicast
        except ValueError:
            host_ok = bool(re.fullmatch(r"(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}", host)) and not host.lower().endswith((".localhost", ".local", ".internal", ".invalid", ".test"))
        return (parsed.scheme == "https" and host_ok and not parsed.username
                and not parsed.password and parsed.port in (None, 443)
                and not any(ch.isspace() for ch in value))
    except ValueError:
        return False


def safe_professional_label(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 300 or SENSITIVE.search(value):
        raise ValueError("Only explicitly authorized non-sensitive professional questions are supported")
    return value


def validate_config(config):
    if config.get("schema_version") != 1:
        raise ValueError("Unsupported configuration schema_version")
    event = config.get("event", {})
    provider = event.get("provider")
    if provider not in {"luma", "partiful", "demo"}:
        raise ValueError("Provider must be luma, partiful, or demo")
    if not isinstance(event.get("id"), str) or not event["id"] or not isinstance(event.get("name"), str) or not event["name"]:
        raise ValueError("Exact event ID and name required")
    if not public_https(event.get("url")):
        raise ValueError("Event URL must be HTTPS without credentials")
    url = urlsplit(event["url"])
    if url.query or url.fragment:
        raise ValueError("Use the canonical event URL without query or fragment")
    if provider == "partiful" and (url.hostname != "partiful.com" or url.path != "/e/" + event["id"]):
        raise ValueError("Partiful event ID and exact event URL must match")
    if provider == "luma":
        if not re.fullmatch(r"evt-[A-Za-z0-9]+", event["id"]) or not re.fullmatch(r"cal-[A-Za-z0-9]+", event.get("calendar_id", "")):
            raise ValueError("Luma requires canonical evt-* and cal-* IDs")
        if url.hostname not in {"luma.com", "lu.ma"}:
            raise ValueError("Luma event URL must use luma.com or lu.ma")
    if timestamp(event["starts_at"]) >= timestamp(event["ends_at"]):
        raise ValueError("Monitoring start must precede end")
    auth = config.get("authorization", {})
    for key in ("host_confirmed", "professional_fields_confirmed", "team_sharing_confirmed"):
        if auth.get(key) is not True:
            raise ValueError("Host must explicitly confirm authorization." + key)
    for key, default, minimum, maximum in (("poll_seconds", 60, 60, 3600), ("max_age_seconds", 180, 60, 3600), ("grace_seconds", 180, 0, 180)):
        value = config.setdefault(key, default)
        if type(value) is not int or not minimum <= value <= maximum:
            raise ValueError(f"{key} is outside its supported bounds")
    if config["max_age_seconds"] < config["poll_seconds"]:
        raise ValueError("max_age_seconds must be at least poll_seconds")
    teams = config.get("team", [])
    if not isinstance(teams, list) or not teams:
        raise ValueError("At least one team member is required")
    team_ids = [identifier(item["id"]) for item in teams]
    if len(set(team_ids)) != len(team_ids) or any(not isinstance(item.get("label"), str) or not item["label"] for item in teams):
        raise ValueError("Team IDs must be unique and labels nonempty")
    questions = config.setdefault("questions", [])
    if not isinstance(questions, list):
        raise ValueError("questions must be a list")
    question_ids = [identifier(q["id"]) for q in questions]
    if len(set(question_ids)) != len(question_ids):
        raise ValueError("Duplicate question IDs")
    labels = [safe_professional_label(q["label"]) for q in questions]
    if len(set(labels)) != len(labels):
        raise ValueError("Question labels must be unique")
    fields = config.setdefault("fields", {})
    if not isinstance(fields, dict) or set(fields) - {"company", "title", "linkedin"}:
        raise ValueError("fields supports only company, title, linkedin")
    for label in fields.values():
        safe_professional_label(label)
    audiences = config.get("audiences", [])
    if not isinstance(audiences, list) or not audiences:
        raise ValueError("At least one approved audience ICP is required")
    audience_ids = [identifier(a["id"]) for a in audiences]
    if len(set(audience_ids)) != len(audience_ids):
        raise ValueError("Audience IDs must be unique")
    for audience in audiences:
        if not isinstance(audience.get("label"), str) or not audience["label"]:
            raise ValueError("Audience label required")
        icp = audience.get("icp", {})
        if icp.get("approved") is not True or not isinstance(icp.get("summary"), str) or not icp["summary"]:
            raise ValueError("Review and approve an evidence-backed ICP before ranking real leads")
        if not icp.get("sources") or any(not public_https(s.get("url")) or not s.get("summary") for s in icp["sources"]):
            raise ValueError("ICP needs cited HTTPS business evidence")
        if audience.setdefault("ranking", "value_first") not in {"value_first", "attendance_first"}:
            raise ValueError("Unknown audience ranking mode")
        minimum = audience.setdefault("min_score", 0)
        if type(minimum) not in (int, float) or not math.isfinite(minimum):
            raise ValueError("min_score must be finite")
        rules = audience.get("rules", [])
        if not isinstance(rules, list) or not rules:
            raise ValueError("Each audience needs reviewed scoring rules")
        rule_ids = []
        for rule in rules:
            rule_ids.append(identifier(rule["id"]))
            field = rule.get("field", "")
            if field not in {"company", "title"} and field not in {"answers." + q for q in question_ids}:
                raise ValueError("Rule fields must reference mapped professional fields/questions")
            op = rule.get("op")
            if op not in OPS:
                raise ValueError("Unsupported rule operation")
            value = rule.get("value")
            if op == "in" and (not isinstance(value, list) or not value or any(not isinstance(v, str) or not v.strip() for v in value)):
                raise ValueError("in rules need nonempty exact text values")
            if op in {"contains", "equals"} and (not isinstance(value, str) or not value.strip()):
                raise ValueError("Text rules need a nonempty value")
            if op.startswith("number_") and (type(value) not in (int, float) or not math.isfinite(value)):
                raise ValueError("Numeric rules require a finite number")
            points = rule.get("points")
            if type(points) is not int or not -100 <= points <= 100:
                raise ValueError("Rule points must be an integer between -100 and 100")
            if "priority" in rule and (type(rule["priority"]) is not int or not -100 <= rule["priority"] <= 100):
                raise ValueError("Rule priority must be an integer between -100 and 100")
            if not isinstance(rule.get("reason"), str) or not rule["reason"]:
                raise ValueError("Every rule needs a human-readable reason")
        if len(set(rule_ids)) != len(rule_ids):
            raise ValueError("Duplicate rule IDs")
    return config


def load_config(path):
    path = Path(path).absolute()
    if path.is_symlink():
        raise ValueError("Configuration symlinks are not supported")
    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate configuration key")
            result[key] = value
        return result
    config = json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=unique_keys)
    validate_config(config)
    raw = Path(config.get("state_dir", "runtime/state"))
    if ".." in raw.parts:
        raise ValueError("State directory must not contain parent traversal")
    state = raw if raw.is_absolute() else path.parent / raw
    state = state.absolute()
    if state == path.parent or state in path.parents or state.name in {".git", "event_crm", "tests", "examples", "docs"}:
        raise ValueError("Use a dedicated private state directory")
    for parent in (state, *state.parents):
        if parent.is_symlink() or (hasattr(parent, "is_junction") and parent.is_junction()):
            raise ValueError("State/config directory symlinks and junctions are not supported")
    state = state.resolve()
    config["_config_path"] = str(path)
    config["_state_dir"] = str(state)
    return config


def config_binding(config):
    # Scoring/cohort changes require an explicit migration, not silent reranking.
    keys = ("event", "team", "questions", "fields", "audiences")
    return hashlib.sha256(canonical({k: config[k] for k in keys}).encode()).hexdigest()


def numeric_answer(value):
    """Parse only unambiguous single quantities. Never guess range endpoints."""
    match = re.fullmatch(r"\s*[$€£]?\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*([kKmMbB]?)\s*", value)
    if not match:
        return None
    number = float(match[1].replace(",", "")) * {"": 1, "k": 1000, "m": 1_000_000, "b": 1_000_000_000}[match[2].lower()]
    return number if math.isfinite(number) else None


def score_guest(guest, audience):
    score, priorities, reasons, missing = 0, [], [], set()
    for rule in audience["rules"]:
        field = rule["field"]
        raw = guest.get("answers", {}).get(field[8:]) if field.startswith("answers.") else guest.get(field)
        if raw is None or not str(raw).strip():
            missing.add(field)
            continue
        value = str(raw).strip()
        op, expected = rule["op"], rule["value"]
        matched = False
        if op == "equals":
            matched = value.casefold() == expected.strip().casefold()
        elif op == "contains":
            matched = expected.strip().casefold() in value.casefold()
        elif op == "in":
            matched = value.casefold() in {v.strip().casefold() for v in expected}
        else:
            number = numeric_answer(value)
            if number is None:
                missing.add(field)
            else:
                matched = number >= expected if op == "number_gte" else number <= expected
        if matched:
            score += rule["points"]
            reasons.append({"rule_id": rule["id"], "points": rule["points"], "reason": rule["reason"], "evidence": value})
            if "priority" in rule:
                priorities.append(rule["priority"])
    # Explicit low-priority conditions take precedence over conflicting high ones.
    priority = min(priorities) if priorities else 0
    return {"score": score, "priority": priority, "reasons": reasons, "missing_fields": sorted(missing)}


def rank_key(record, audience):
    attended = 0 if record.get("checked_in") is True else 1
    value = -record["score"]
    order = (attended, value) if audience["ranking"] == "attendance_first" else (value, attended)
    return (-record["priority"], *order, record["name"].casefold(), record["id"])
