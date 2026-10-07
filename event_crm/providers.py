"""Read-only provider adapters. No provider write endpoints or contact persistence.

Luma response fields follow its public OpenAPI document, not private web APIs.
An injected opener is for offline tests; the default opener rejects redirects.
"""

import csv
import hashlib
import json
import math
import os
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


API_BASE = "https://public-api.luma.com"
STATUSES = {"approved", "cant_go", "session", "pending_approval", "invited", "declined", "waitlist"}
LUMA_COUNT_STATUSES = ("approved", "pending_approval", "invited", "declined", "waitlist")
UNSAFE_LABEL = re.compile(
    r"\b(?:e[\s-]?mail|phone|mobile|telephone|contact|immigration|visa|citizenship|"
    r"passport|nationality|religion|medical|disability|gender|sexual|race|ethnicity|"
    r"birth|address|ssn|social security)\b", re.I)
EMAIL = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
PHONE = re.compile(r"(?<!\w)(?:\+\d[\d ()-]{7,}\d|\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4})(?!\w)")


def _now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _timestamp(value):
    if not isinstance(value, str):
        raise ValueError("Timestamp must be an ISO datetime with timezone")
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("Timestamp must be an ISO datetime with timezone") from None
    if stamp.tzinfo is None:
        raise ValueError("Timestamp requires a timezone")
    return stamp


def _text(value, *, required=False, redact=False):
    if value is None:
        value = ""
    if not isinstance(value, str) or len(value) > 10000:
        raise ValueError("Expected a bounded text value")
    value = value.strip()
    if value == "No response":
        value = ""
    if required and not value:
        raise ValueError("Required source identity is missing")
    if redact:
        value = EMAIL.sub("[redacted]", value)
        value = PHONE.sub("[redacted]", value)
    return value


def _safe_url(value, *, linkedin=False):
    value = _text(value)
    if not value:
        return ""
    try:
        parsed = urlsplit(value)
        valid = (parsed.scheme == "https" and parsed.hostname and not parsed.username
                 and not parsed.password and parsed.port in (None, 443))
    except ValueError:
        valid = False
    if not valid or (linkedin and parsed.hostname not in ("linkedin.com", "www.linkedin.com")):
        raise ValueError("Invalid professional URL")
    if linkedin and (not parsed.path.startswith("/in/") or parsed.query or parsed.fragment):
        raise ValueError("LinkedIn must be a canonical https profile URL without tracking parameters")
    return value


def _mapping(config):
    auth = config.get("authorization", {})
    if any(auth.get(k) is not True for k in (
            "host_confirmed", "professional_fields_confirmed", "team_sharing_confirmed")):
        raise ValueError("Host, professional fields, and team sharing authorization are required")
    fields = config.get("fields", {})
    if not isinstance(fields, dict) or set(fields) - {"company", "title", "linkedin"}:
        raise ValueError("Provide exact labels only for available professional source fields")
    questions = config.get("questions", [])
    if not isinstance(questions, list):
        raise ValueError("Questions must be an explicit professional allowlist")
    labels = list(fields.values())
    ids = set()
    question_labels = set()
    for question in questions:
        if not isinstance(question, dict):
            raise ValueError("Invalid professional question mapping")
        qid = question.get("id")
        label = question.get("label")
        if (not isinstance(qid, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", qid)
                or qid in ids or label in question_labels or UNSAFE_LABEL.search(qid)):
            raise ValueError("Invalid or duplicated professional question ID/label")
        ids.add(qid)
        question_labels.add(label)
        labels.append(label)
    for label in labels:
        if not isinstance(label, str) or not label.strip() or UNSAFE_LABEL.search(label):
            raise ValueError("Only explicitly allowed professional source questions may be mapped")
    return fields, questions


def partiful_identity(event_url, name, linkedin_url, company):
    """Byte-compatible with browser/partiful.mjs; exact configured URL and text."""
    encoded = json.dumps([event_url, name, linkedin_url, company], ensure_ascii=False,
                         separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def validate_snapshot(snapshot, config):
    """Return a fresh, strictly validated normalized snapshot or raise ValueError.

    Unknown payload keys fail closed, including contacts. Reader adapters discard
    unmapped provider columns before reaching this boundary. Counts partition the
    actual named identities; badge headcounts are verified inside the reader.
    """
    _, questions = _mapping(config)
    allowed = {"schema_version", "provider", "event_id", "event_url", "calendar_id",
               "scan_started_at", "captured_at", "complete", "source_counts", "guests", "source_evidence"}
    if not isinstance(snapshot, dict) or set(snapshot) - allowed:
        raise ValueError("Unexpected normalized snapshot fields")
    event = config["event"]
    if type(snapshot.get("schema_version")) is not int or snapshot.get("schema_version") != 1 or snapshot.get("complete") is not True:
        raise ValueError("Only complete schema version 1 snapshots are accepted")
    for key, expected in (("provider", event["provider"]), ("event_id", event["id"]),
                          ("event_url", event["url"]), ("calendar_id", event.get("calendar_id"))):
        if snapshot.get(key) != expected:
            raise ValueError("Snapshot does not match the configured provider/event/calendar")
    if event["provider"] not in ("luma", "partiful", "demo"):
        raise ValueError("Unsupported provider")
    start = _timestamp(snapshot.get("scan_started_at"))
    captured = _timestamp(snapshot.get("captured_at"))
    if captured < start or captured > datetime.now(timezone.utc):
        raise ValueError("Invalid snapshot time order or future capture")
    counts = snapshot.get("source_counts")
    if (not isinstance(counts, dict) or not counts or any(
            status not in STATUSES or type(count) is not int or count < 0
            for status, count in counts.items())):
        raise ValueError("Source counts must partition named guests by known status")
    rows = snapshot.get("guests")
    if not isinstance(rows, list):
        raise ValueError("Guests must be a list")
    question_ids = {q["id"] for q in questions}
    seen = set()
    clean = []
    guest_allowed = {"source_id", "name", "company", "title", "linkedin_url", "answers",
                     "checked_in", "approval_status", "photo_url", "photo_reviewed"}
    required = guest_allowed - {"photo_url", "photo_reviewed"}
    for guest in rows:
        if not isinstance(guest, dict) or set(guest) - guest_allowed or required - set(guest):
            raise ValueError("Unexpected or missing normalized guest fields")
        if guest["checked_in"] is not None and type(guest["checked_in"]) is not bool:
            raise ValueError("Attendance requires an explicit boolean or null")
        if guest["approval_status"] not in STATUSES:
            raise ValueError("Unknown approval status")
        normalized = {k: _text(guest[k], required=k in ("source_id", "name"), redact=k != "source_id")
                      for k in ("source_id", "name", "company", "title")}
        normalized["linkedin_url"] = _safe_url(guest["linkedin_url"], linkedin=True)
        answers = guest["answers"]
        if not isinstance(answers, dict) or set(answers) - question_ids:
            raise ValueError("Unmapped signup answers are forbidden")
        normalized["answers"] = {k: _text(v, redact=True) for k, v in answers.items()}
        normalized.update(checked_in=guest["checked_in"], approval_status=guest["approval_status"])
        if normalized["source_id"] in seen:
            raise ValueError("Duplicate source identity; do not merge guests by name")
        seen.add(normalized["source_id"])
        if event["provider"] == "partiful" and normalized["source_id"] != partiful_identity(
                event["url"], normalized["name"], normalized["linkedin_url"], normalized["company"]):
            raise ValueError("Partiful source identity does not match its exact professional identity")
        if guest.get("photo_url"):
            if guest.get("photo_reviewed") is not True:
                raise ValueError("Photos require explicit review")
            normalized.update(photo_url=_safe_url(guest["photo_url"]), photo_reviewed=True)
        clean.append(normalized)
    observed = Counter(g["approval_status"] for g in clean)
    if sum(counts.values()) != len(clean) or any(counts.get(k) != v for k, v in observed.items()):
        raise ValueError("Source counts disagree with the named guest rows")
    evidence = snapshot.get("source_evidence")
    if evidence is not None:
        if event["provider"] != "partiful" or not isinstance(evidence, dict) or set(evidence) != {"approved", "cant_go"}:
            raise ValueError("Unexpected source geometry evidence")
        for view, proof in evidence.items():
            if not isinstance(proof, dict) or set(proof) != {
                    "badge_count", "named_count", "scroll_height", "header_height", "row_height"}:
                raise ValueError("Invalid source geometry evidence")
            named, badge = proof["named_count"], proof["badge_count"]
            if (type(named) is not int or type(badge) is not int or named < 0
                    or named != counts.get(view, 0) or badge < named):
                raise ValueError("Source geometry evidence counts disagree")
            extent, header, height = proof["scroll_height"], proof["header_height"], proof["row_height"]
            if (type(extent) is not int or extent <= 0 or type(header) not in (int, float)
                    or not 0 < header <= extent):
                raise ValueError("Invalid source table extent")
            if named:
                if (type(height) not in (int, float) or not math.isfinite(height) or height <= 0
                        or int(header + named * height + 0.5) != extent):
                    raise ValueError("Source row geometry does not cover the complete table")
            elif height is not None or badge != 0:
                raise ValueError("Empty view evidence is inconsistent")
    result = {key: snapshot[key] for key in allowed if key in snapshot}
    result["calendar_id"] = event.get("calendar_id")
    result["source_counts"] = dict(counts)
    result["guests"] = clean
    if evidence is not None:
        result["source_evidence"] = {view: dict(proof) for view, proof in evidence.items()}
    return result


def load_snapshot(path, config):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON key in snapshot")
            result[key] = value
        return result
    path = Path(path)
    if path.stat().st_size > 30_000_000:
        raise ValueError("Snapshot is too large")
    with path.open(encoding="utf-8-sig") as handle:
        return validate_snapshot(json.load(handle, object_pairs_hook=pairs), config)


def _snapshot(config, started, captured, guests):
    counts = dict(Counter(g["approval_status"] for g in guests)) or {"approved": 0}
    return validate_snapshot({
        "schema_version": 1, "provider": config["event"]["provider"],
        "event_id": config["event"]["id"], "event_url": config["event"]["url"],
        "calendar_id": config["event"].get("calendar_id"), "scan_started_at": started,
        "captured_at": captured, "complete": True, "source_counts": counts, "guests": guests,
    }, config)


def import_csv(path, config, captured_at):
    """One host-supplied complete export; no claim of live browser/API access.

    Only exact strings 'true' and 'false' are booleans. Empty/'null'/'unknown'
    means unavailable. Every other spelling is rejected for operator mapping.
    """
    fields, questions = _mapping(config)
    _timestamp(captured_at)
    columns = {"id": "source_id", "name": "name", "checked_in": "checked_in",
               "approval_status": "approval_status"}
    overrides = config.get("csv", {})
    if not isinstance(overrides, dict) or set(overrides) - set(columns):
        raise ValueError("Unsupported CSV source mapping")
    columns.update(overrides)
    if any(not isinstance(label, str) or not label.strip() or UNSAFE_LABEL.search(label) for label in columns.values()):
        raise ValueError("CSV identity/status fields cannot map to contact or sensitive columns")
    required = set(columns.values()) | set(fields.values()) | {q["label"] for q in questions}
    if config["event"]["provider"] == "partiful":
        required.discard(columns["id"])
    guests = []
    with Path(path).open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        headers = reader.fieldnames
        if not headers or len(headers) != len(set(headers)) or required - set(headers):
            raise ValueError("CSV has missing or duplicate exact mapped column labels")
        for row in reader:
            if None in row or any(row[key] is None for key in required):
                raise ValueError("CSV row width is inconsistent")
            raw_check = row[columns["checked_in"]].strip()
            if raw_check not in ("true", "false", "", "null", "unknown"):
                raise ValueError("CSV attendance must be true, false, null, unknown, or empty")
            guest = {
                "name": _text(row[columns["name"]], required=True, redact=True),
                "company": _text(row[fields["company"]], redact=True) if "company" in fields else "",
                "title": _text(row[fields["title"]], redact=True) if "title" in fields else "",
                "linkedin_url": _safe_url(row[fields["linkedin"]], linkedin=True) if "linkedin" in fields else "",
                "answers": {q["id"]: _text(row[q["label"]], redact=True) for q in questions},
                "checked_in": {"true": True, "false": False}.get(raw_check),
                "approval_status": row[columns["approval_status"]].strip(),
            }
            guest["source_id"] = (partiful_identity(config["event"]["url"], guest["name"],
                                    guest["linkedin_url"], guest["company"])
                                  if config["event"]["provider"] == "partiful"
                                  else _text(row[columns["id"]], required=True))
            guests.append(guest)
    return _snapshot(config, captured_at, captured_at, guests)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Luma API redirect refused; credentials were not forwarded")


def _get(opener, key, calendar_id, path, query=None):
    url = API_BASE + path + ("?" + urlencode(query) if query else "")
    request = Request(url, headers={"x-luma-api-key": key, "x-luma-calendar-id": calendar_id,
                                   "Accept": "application/json"}, method="GET")
    try:
        with opener.open(request, timeout=30) as response:
            if response.geturl() != url:
                raise ValueError("Luma API redirect refused")
            data = response.read(30_000_001)
            if len(data) > 30_000_000:
                raise ValueError("Luma API response is too large")
            payload = json.loads(data)
    except HTTPError as error:
        raise ValueError(f"Luma read failed with HTTP {error.code}; last good data is preserved") from None
    except URLError:
        raise ValueError("Luma read failed; last good data is preserved") from None
    if not isinstance(payload, dict):
        raise ValueError("Unexpected Luma response shape")
    return payload


def _luma_binding(detail, event):
    if any(detail.get(k) != v for k, v in (
            ("id", event["id"]), ("url", event["url"]), ("calendar_id", event["calendar_id"]),
            ("access", "manage"), ("platform", "luma"))):
        raise ValueError("Luma event/calendar binding or host access does not match")
    counts = detail.get("guest_counts", {})
    result = {}
    for status in LUMA_COUNT_STATUSES:
        count = counts.get(status, {}).get("guests")
        if type(count) is not int or count < 0:
            raise ValueError("Luma event is missing authoritative guest counts")
        result[status] = count
    return result


def _luma_checkin(raw):
    tickets = raw.get("event_tickets")
    if tickets is None:
        return None
    if not isinstance(tickets, list):
        raise ValueError("Unknown Luma ticket shape")
    states = []
    ids = set()
    for ticket in tickets:
        if not isinstance(ticket, dict) or not isinstance(ticket.get("id"), str) or not ticket["id"] or ticket["id"] in ids:
            raise ValueError("Invalid or duplicated Luma ticket")
        ids.add(ticket["id"])
        if "checked_in_at" not in ticket:
            states.append(None)
        elif ticket["checked_in_at"] is None:
            states.append(False)
        else:
            _timestamp(ticket["checked_in_at"])
            states.append(True)
    # A group ticket check-in cannot establish which named registrant arrived.
    if len(states) != 1:
        return None
    # The public schema does not define EventTicket.name as a person's name.
    # Association comes from the ticket nested under this exact Guest ID.
    return states[0]


def _luma_question_mapping(detail, fields, questions):
    source = detail.get("registration_questions", [])
    if not isinstance(source, list):
        raise ValueError("Luma registration question schema is unavailable")
    mapping = {}
    for label in set(fields.values()) | {q["label"] for q in questions}:
        matches = [q for q in source if q.get("label") == label]
        if len(matches) != 1 or not isinstance(matches[0].get("id"), str):
            raise ValueError("Luma exact professional question label is missing or ambiguous")
        question = matches[0]
        if question.get("question_type") not in {"text", "select", "company", "linkedin", "url", "agree-check"}:
            raise ValueError("Luma mapped source type is not a professional field")
        mapping[label] = question
    return mapping


def _luma_guest(raw, fields, questions, mapping):
    if not isinstance(raw, dict):
        raise ValueError("Unexpected Luma guest entry")
    raw_answers = raw.get("registration_answers") or []
    if not isinstance(raw_answers, list):
        raise ValueError("Unexpected Luma registration answers")
    selected = {}
    for label, question in mapping.items():
        matching = [a for a in raw_answers if isinstance(a, dict) and a.get("question_id") == question["id"]]
        if len(matching) > 1:
            raise ValueError("Duplicate Luma question answer")
        if matching and (matching[0].get("label") != label
                         or matching[0].get("question_type") != question["question_type"]):
            raise ValueError("Luma professional question schema changed during scan")
        selected[label] = matching[0].get("value") if matching else None

    def value(label, component=None):
        answer = selected[label]
        if mapping[label]["question_type"] == "company" and answer is not None:
            if not isinstance(answer, dict) or component not in ("company", "job_title"):
                raise ValueError("Company answer requires an explicit company/title field mapping")
            answer = answer.get(component)
        if isinstance(answer, list) and all(isinstance(item, str) for item in answer):
            answer = "; ".join(answer)
        if type(answer) is bool:
            answer = "true" if answer else "false"
        return _text(answer, redact=True)

    return {
        "source_id": _text(raw.get("id"), required=True),
        "name": _text(raw.get("user_name"), required=True, redact=True),
        "company": value(fields["company"], "company") if "company" in fields else "",
        "title": value(fields["title"], "job_title") if "title" in fields else "",
        "linkedin_url": _safe_url(value(fields["linkedin"]), linkedin=True) if "linkedin" in fields else "",
        "answers": {q["id"]: value(q["label"]) for q in questions},
        "checked_in": _luma_checkin(raw), "approval_status": raw.get("approval_status"),
    }


def fetch_luma(config, *, opener=None):
    """Read a fully paginated, calendar-bound Luma guest snapshot using GET only."""
    fields, questions = _mapping(config)
    event = config["event"]
    if event.get("provider") != "luma" or not event.get("calendar_id"):
        raise ValueError("Luma event and calendar binding are required")
    key = os.environ.get("LUMA_API_KEY", "")
    if not key:
        raise ValueError("LUMA_API_KEY is required in the environment")
    client = opener if opener is not None else build_opener(_NoRedirect())
    started = _now()
    calendar = _get(client, key, event["calendar_id"], "/v1/calendars/get")
    if calendar.get("id") != event["calendar_id"]:
        raise ValueError("Luma key does not match the configured calendar")
    detail = _get(client, key, event["calendar_id"], "/v1/events/get", {"event_id": event["id"]})
    expected = _luma_binding(detail, event)
    mapping = _luma_question_mapping(detail, fields, questions)
    guests, ids, cursors = [], set(), set()
    cursor = None
    for _page in range(10000):
        query = {"event_id": event["id"], "pagination_limit": 100,
                 "sort_column": "created_at", "sort_direction": "asc"}
        if cursor is not None:
            query["pagination_cursor"] = cursor
        page = _get(client, key, event["calendar_id"], "/v1/events/guests/list", query)
        entries = page.get("entries")
        if not isinstance(entries, list) or type(page.get("has_more")) is not bool:
            raise ValueError("Luma pagination completeness is unknown")
        for raw in entries:
            guest = _luma_guest(raw, fields, questions, mapping)
            if guest["source_id"] in ids:
                raise ValueError("Repeated Luma identity across pages; retry the scan")
            ids.add(guest["source_id"])
            guests.append(guest)
        if not page["has_more"]:
            break
        cursor = page.get("next_cursor")
        if not entries or not isinstance(cursor, str) or not cursor or cursor in cursors:
            raise ValueError("Incomplete or looping Luma pagination")
        cursors.add(cursor)
    else:
        raise ValueError("Luma page limit exceeded")
    end_detail = _get(client, key, event["calendar_id"], "/v1/events/get", {"event_id": event["id"]})
    if _luma_binding(end_detail, event) != expected or _luma_question_mapping(end_detail, fields, questions) != mapping:
        raise ValueError("Luma roster or question schema changed during the scan; retry")
    observed = Counter(g["approval_status"] for g in guests)
    if any(observed[status] != count for status, count in expected.items()):
        raise ValueError("Luma pagination did not account for every named guest")
    return _snapshot(config, started, _now(), guests)
