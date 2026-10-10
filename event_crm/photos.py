"""Private, identity-bound portrait preparation. Never called by attendance polling.

An authorized operator/agent discovers and reviews sources; this module enforces
the bounded fallback order, validates/caches assets and accounts for every lead.
It does not guess identities, search faces or call a paid enrichment service.
"""
from __future__ import annotations

from collections import Counter
import hashlib
import io
import json
import warnings

from .core import canonical, config_binding, timestamp, utcnow
from .research import _safe_url, _fetch_public_page
from .photo_urls import image_url

KINDS = ("event_avatar", "professional_profile", "official_page", "paid_result")
OUTCOMES = ("pending", "not_found", "blocked", "ambiguous", "rejected")
MAX_BYTES = 5 * 1024 * 1024
MAX_PIXELS = 16_000_000
MIME = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}


def fingerprint(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def download(url):
    return _fetch_public_page(image_url(url), timeout=12, validator=image_url,
                              max_bytes=MAX_BYTES, content_types=tuple(MIME), cross_site=True)


def _pillow():
    try:
        from PIL import Image, ImageOps
    except ImportError:
        raise RuntimeError('Install portrait support first: python -m pip install ".[photos]"') from None
    return Image, ImageOps


def thumbnail(response):
    """Decode then re-encode a small JPEG, removing EXIF/ICC/text metadata."""
    Image, ImageOps = _pillow()
    body = response.get("body")
    mime = response.get("content_type", "").split(";", 1)[0].strip().lower()
    if mime not in MIME or not isinstance(body, bytes) or not body or len(body) > MAX_BYTES or response.get("truncated"):
        raise ValueError("Unsupported, empty or oversized image response")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(body), formats=[MIME[mime]]) as check:
                if check.format != MIME[mime] or getattr(check, "is_animated", False) or min(check.size) < 48 or check.width * check.height > MAX_PIXELS:
                    raise ValueError("Image format/dimensions are not suitable for a portrait")
                check.verify()
            with Image.open(io.BytesIO(body), formats=[MIME[mime]]) as source:
                source.load()
                oriented = ImageOps.exif_transpose(source).convert("RGBA")
                oriented.thumbnail((256, 256))
                clean = Image.new("RGB", oriented.size, "white")
                clean.paste(oriented, mask=oriented.getchannel("A"))
                out = io.BytesIO()
                clean.save(out, "JPEG", quality=85, optimize=True)
                return out.getvalue()
    except Exception as exc:
        # Plugins also raise SyntaxError/struct.error. Confine this broad catch
        # to the untrusted decoder, not plan validation or database operations.
        raise ValueError("Image could not be safely decoded") from exc


def _rows(store, *, with_assets=False):
    with store.connect() as db:
        db.execute("BEGIN")
        store.assert_binding(db)
        guests = list(db.execute("SELECT * FROM guests ORDER BY alias"))
        asset_column = "asset" if with_assets else "CASE WHEN asset IS NOT NULL THEN 1 ELSE NULL END AS asset"
        portraits = {r["source_id"]: dict(r) for r in db.execute(
            "SELECT source_id,identity,revision,metadata,digest,source_digest," + asset_column + " FROM portraits")}
    if not guests:
        raise ValueError("Initialize the reviewed cohort before preparing photos")
    return guests, portraits


def plan(store):
    guests, portraits = _rows(store)
    people = []
    for g in guests:
        p = portraits.get(g["source_id"])
        profile = json.loads(g["profile"])
        valid = p and p["identity"] == g["identity"] and p["asset"] is not None
        meta = json.loads(p["metadata"]) if p and p["identity"] == g["identity"] else {}
        try:
            hint = image_url(profile.get("photo_url", ""))
        except ValueError:
            hint = ""
        people.append({"id": g["alias"], "identity": fingerprint(g["identity"]),
                       "revision": p["revision"] if p else 0,
                       "name": profile["name"], "company": profile["company"],
                       "linkedin_url": profile["linkedin_url"],
                       "event_avatar_hint": hint,
                       "action": "keep" if valid else "search", "candidates": [],
                       "outcome": meta.get("outcome", "pending") if meta.get("outcome") != "stored" else "pending",
                       "reason": meta.get("reason", ""), "source_checks": meta.get("source_checks", [])})
    return {"schema_version": 1, "binding": config_binding(store.config), "people": people}


def report(store):
    guests, portraits = _rows(store)
    people = []
    for g in guests:
        p = portraits.get(g["source_id"])
        profile = json.loads(g["profile"])
        meta = json.loads(p["metadata"]) if p else {}
        valid = p and p["identity"] == g["identity"] and p["asset"] is not None
        state = "stored" if valid else ("identity_changed" if p and p["identity"] != g["identity"] else meta.get("outcome", "pending"))
        people.append({"id": g["alias"], "name": profile["name"], "company": profile["company"],
                       "state": state, "digest": p["digest"] if valid else "", "evidence": meta.get("evidence"),
                       "checked_at": meta.get("checked_at"), "last_attempt": meta.get("outcome", "pending"),
                       "attempts": meta.get("attempts", []), "reason": meta.get("reason", "")})
    counts = dict(Counter(p["state"] for p in people))
    return {"generated_at": utcnow().isoformat(), "tracked": len(people), "stored": counts.get("stored", 0),
            "unresolved": len(people) - counts.get("stored", 0), "counts": counts,
            "render_verification": "required_in_authenticated_browser", "people": people}


def _text(value, label, minimum=1):
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= 1000:
        raise ValueError(f"Provide bounded {label}")
    return value.strip()


def _candidate(c, profile, config):
    allowed = {"kind", "page_url", "image_url", "observed_name", "observed_company", "identity_basis",
               "reviewer", "reviewed_at", "non_default", "cache_authorized", "paid_authorized"}
    if not isinstance(c, dict) or set(c) - allowed or c.get("kind") not in KINDS:
        raise ValueError("Unknown photo candidate fields or source kind")
    if c.get("non_default") is not True or c.get("cache_authorized") is not True:
        raise ValueError("Confirm a non-default portrait and permission to cache/share it")
    if c.get("observed_name") != profile["name"] or c.get("observed_company") != profile["company"]:
        raise ValueError("Portrait evidence must corroborate the exact tracked name and company")
    for key in ("identity_basis", "reviewer"):
        _text(c.get(key), key, 20 if key == "identity_basis" else 1)
    age = (utcnow() - timestamp(c.get("reviewed_at"))).total_seconds()
    if not -15 <= age <= 7 * 86400:
        raise ValueError("Portrait review must be current (within seven days)")
    page = _safe_url(c.get("page_url"))
    if c["kind"] == "event_avatar" and page.rstrip("/") != config["event"]["url"].rstrip("/"):
        raise ValueError("Event avatar must come from this exact authorized event")
    if c["kind"] == "paid_result" and c.get("paid_authorized") is not True:
        raise ValueError("Paid results require separate explicit authorization")
    return {**c, "page_url": page, "image_url": image_url(c.get("image_url"))}


def _unchanged(item, old):
    meta = json.loads(old["metadata"]) if old else {}
    return (item.get("action") == "search" and not item.get("candidates")
            and item.get("outcome") == meta.get("outcome", "pending")
            and item.get("reason", "") == meta.get("reason", "")
            and item.get("source_checks", []) == meta.get("source_checks", []))


def _same_source(url):
    return url.split("?", 1)[0]


def apply(store, packet, *, fetcher=download):
    """Apply one complete reviewed plan; per-person CAS, at most four candidates.

    A trusted injected fetcher is for synthetic tests only. No network access
    happens until the entire packet's binding, identities and reviews validate.
    """
    guests, portraits = _rows(store, with_assets=True)
    by_alias = {g["alias"]: g for g in guests}
    if not isinstance(packet, dict) or packet.get("schema_version") != 1 or packet.get("binding") != config_binding(store.config):
        raise ValueError("Wrong portrait plan/event binding")
    people = packet.get("people")
    if not isinstance(people, list) or len(people) != len(guests) or {p.get("id") for p in people if isinstance(p, dict)} != set(by_alias):
        raise ValueError("Photo plan must account for every tracked identity exactly once")
    prepared = []
    for item in people:
        g = by_alias[item["id"]]
        old = portraits.get(g["source_id"])
        profile = json.loads(g["profile"])
        if item.get("identity") != fingerprint(g["identity"]) or type(item.get("revision")) is not int:
            raise ValueError(f"Guest {item['id']}: changed identity or invalid revision")
        if item["revision"] != (old["revision"] if old else 0) and item.get("action") != "keep" and not _unchanged(item, old):
            raise ValueError(f"Guest {item['id']}: stale portrait plan; generate a fresh plan")
        if item.get("action") not in ("keep", "search", "reject"):
            raise ValueError("Unknown portrait action")
        candidates = item.get("candidates", [])
        if not isinstance(candidates, list) or len(candidates) > len(KINDS):
            raise ValueError("Use at most four reviewed fallback candidates per person")
        reviewed = []
        for index, c in enumerate(candidates):
            try:
                reviewed.append(_candidate(c, profile, store.config))
            except (ValueError, TypeError) as exc:
                raise ValueError(f"Guest {item['id']}, candidate {index + 1}: {exc}") from None
        candidates = reviewed
        if item["action"] != "search" and candidates:
            raise ValueError("Candidates only belong to a search action")
        if item.get("outcome") not in OUTCOMES:
            raise ValueError("Unknown unresolved portrait outcome")
        checks = item.get("source_checks", [])
        if not isinstance(checks, list) or len(checks) > 4:
            raise ValueError("At most four source checks are permitted")
        for check in checks:
            if not isinstance(check, dict) or set(check) != {"kind", "result", "reason"} or check["kind"] not in KINDS or check["result"] not in {"not_found", "blocked", "ambiguous", "not_authorized"}:
                raise ValueError("Invalid source check")
            _text(check["reason"], "source check reason")
        if item["action"] == "reject" or item["outcome"] != "pending":
            _text(item.get("reason"), "unresolved/rejection reason")
        if item["outcome"] == "not_found" and not set(KINDS[:3]).issubset({c["kind"] for c in checks if c["result"] == "not_found"}):
            raise ValueError("Not found requires accounting for event, professional and official sources")
        prepared.append((g, item, sorted(candidates, key=lambda c: KINDS.index(c["kind"]))))

    if any(candidates for _, _, candidates in prepared):
        _pillow()  # Dependency failure is a setup error, before any fetch/write.
    for g, item, candidates in sorted(prepared, key=lambda entry: entry[1]["action"] != "reject"):
        old = portraits.get(g["source_id"])
        if item["action"] == "keep" or (not old or old["identity"] == g["identity"]) and _unchanged(item, old):
            continue
        meta = json.loads(old["metadata"]) if old else {}
        # Revocations survive reruns, including later source corrections.
        rejected_urls = set(meta.get("rejected_urls", []))
        rejected_hashes = set(meta.get("rejected_hashes", []))
        rejected_sources = set(meta.get("rejected_source_hashes", []))
        valid = old and old["identity"] == g["identity"]
        asset = old["asset"] if valid else None
        digest = old["digest"] if valid else ""
        source_digest = old["source_digest"] if valid else ""
        evidence = meta.get("evidence") if valid else None
        attempts = list(item.get("source_checks", []))
        outcome = item["outcome"]
        if item["action"] == "reject":
            if evidence:
                rejected_urls.add(evidence["image_url"])
                rejected_urls.add(evidence.get("final_url", evidence["image_url"]))
            if digest:
                rejected_hashes.add(digest)
            if source_digest:
                rejected_sources.add(source_digest)
            asset, digest, source_digest, evidence, outcome = None, "", "", None, "rejected"
        else:
            for c in candidates:
                if _same_source(c["image_url"]) in {_same_source(u) for u in rejected_urls}:
                    attempts.append({"kind": c["kind"], "result": "rejected", "reason": "Previously rejected source"})
                    outcome = "ambiguous"
                    continue
                try:
                    response = fetcher(c["image_url"])
                    final_url = image_url(response.get("url", c["image_url"]))
                    if _same_source(final_url) in {_same_source(u) for u in rejected_urls}:
                        raise ValueError("Previously rejected redirected source")
                    candidate_asset = thumbnail(response)
                    body_hash = hashlib.sha256(response["body"]).hexdigest()
                    candidate_hash = hashlib.sha256(candidate_asset).hexdigest()
                    if candidate_hash in rejected_hashes or body_hash in rejected_sources:
                        raise ValueError("Previously rejected image content")
                    # Shared bytes for two different tracked people are a review
                    # blocker, not proof of identity or a reusable default avatar.
                    with store.connect() as db:
                        duplicate = db.execute("SELECT 1 FROM portraits WHERE (digest=? OR source_digest=?) AND source_id!=? AND asset IS NOT NULL", (candidate_hash, body_hash, g["source_id"])).fetchone()
                    if duplicate:
                        attempts.append({"kind": c["kind"], "result": "ambiguous", "reason": "Same image belongs to another tracked identity"})
                        outcome = "ambiguous"
                        continue
                    asset, digest, source_digest = candidate_asset, candidate_hash, body_hash
                    evidence = {**c, "final_url": final_url}
                    outcome = "stored"
                    attempts.append({"kind": c["kind"], "result": "stored"})
                    break
                except (ValueError, OSError):
                    # Do not echo signed URLs, provider bodies or credentials.
                    attempts.append({"kind": c["kind"], "result": "blocked", "reason": "Fetch/validation failed; inspect the authorized source"})
                    outcome = "blocked"
        reason = item.get("reason", "") or (attempts[-1].get("reason", "") if attempts else "")
        meta = {"outcome": outcome, "reason": reason, "checked_at": utcnow().isoformat(),
                "attempts": attempts, "evidence": evidence, "rejected_urls": sorted(rejected_urls),
                "rejected_hashes": sorted(rejected_hashes), "rejected_source_hashes": sorted(rejected_sources),
                "source_checks": item.get("source_checks", [])}
        with store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            store.assert_binding(db)
            current = db.execute("SELECT identity FROM guests WHERE source_id=?", (g["source_id"],)).fetchone()
            latest = db.execute("SELECT revision FROM portraits WHERE source_id=?", (g["source_id"],)).fetchone()
            if not current or current[0] != g["identity"] or (latest[0] if latest else 0) != item["revision"]:
                raise ValueError("Portrait changed concurrently; preserved current state, generate a fresh plan")
            if asset and db.execute("SELECT 1 FROM portraits WHERE (digest=? OR source_digest=?) AND source_id!=? AND asset IS NOT NULL", (digest, source_digest, g["source_id"])).fetchone():
                raise ValueError("Duplicate portrait detected concurrently; review required")
            db.execute("INSERT OR REPLACE INTO portraits VALUES (?,?,?,?,?,?,?)",
                       (g["source_id"], g["identity"], item["revision"] + 1, canonical(meta), digest, source_digest, asset))
    return report(store)
