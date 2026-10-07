# Runtime interfaces

Internal implementation contract; JSON keys are stable across modules.

## Configuration

`schema_version: 1`, `event: {provider: luma|partiful|demo, id, url, calendar_id (Luma only), name, starts_at, ends_at}`, `authorization: {host_confirmed: true, professional_fields_confirmed: true, team_sharing_confirmed: true}`, `team: [{id,label}]`, `questions: [{id,label}]`, `fields: {company: exact source label, title: exact source label, linkedin: exact source label}`, `audiences: [{id,label,icp: {approved:true, summary, sources:[{url,summary}]},rules:[{id,field,op,value,points,reason,priority?}],min_score:0,ranking: value_first|attendance_first}]`, `state_dir`, `poll_seconds` (>=60), `max_age_seconds` (>=poll), `grace_seconds` (0..180).

Rules fields: `company`, `title`, `answers.QUESTION_ID`; ops `equals`, `contains`, `in`, `number_gte`, `number_lte`. `priority` optional integer grouping, higher first, always before attendance. Missing evidence yields no positive points. Score is a heuristic, not purchase intent or predicted revenue. Core default priority 0.

## Normalized source snapshot

`{schema_version:1,provider,event_id,event_url,calendar_id,scan_started_at,captured_at,complete:true,source_counts:{VIEW:count},guests:[{source_id,name,company,title,linkedin_url,answers:{QUESTION_ID: text},checked_in:boolean|null,approval_status,photo_url?,photo_reviewed?:boolean}]}`.

No contact fields or raw provider payloads. Source IDs stay private. `checked_in:null` means unavailable, not false. Attendance updates must include explicit booleans for all existing tracked identities; roster initialization may have nulls. Source readers must validate pagination/view completeness and exact binding. Partiful identity is deterministic SHA256 of exact event URL + display name + LinkedIn + company; duplicates fail closed.

Optional Partiful `source_evidence` carries approved/cant_go view objects with `badge_count`, `named_count`, `scroll_height`, `header_height`, `row_height`. Complete contiguous named-row geometry can validate a badge discrepancy without attributing it to any individual guest. `source_counts` always counts actual named records, never plus-one headcounts. Professional `fields` may be a subset when the event does not collect every field; absent unmapped fields stay empty.

## Provider APIs

`event_crm.providers.fetch_luma(config, *, opener=None) -> snapshot` reads LUMA_API_KEY from environment, canonical API only, GET only, no credential redirects. `event_crm.providers.load_snapshot(path,config) -> snapshot` validates external normalized snapshot. `event_crm.providers.import_csv(path,config,captured_at) -> snapshot` reads a host-supplied export with exact mapped columns; never pretends a CSV import is continuous live access. CLI passes captured_at explicitly. Fields `csv` may specify `id`, `name`, `checked_in`, `approval_status`; default source headers are these exact normalized keys. No implicit truthy strings.

## Core and persistence APIs

`event_crm.core.load_config(path) -> config` includes absolute `_config_path` and `_state_dir`; validates schema and authorizations. `score_guest(guest,audience) -> {score,priority,reasons,missing_fields}`. `rank_key(record,audience)` sorts ascending. `event_crm.store.Store(config)` uses SQLite in `_state_dir`; methods `ingest(snapshot, initial=False) -> aggregate dict`, `dashboard() -> dict`, `assign(alias,owner_id,status,actor) -> dict`. Status is `new|assigned|contacted|follow_up|done`. `dashboard` returns `{event:{name,provider,starts_at,ends_at},revision,captured_at,team,questions,audiences:[{id,label,ranking,records:[{id,name,company,title,linkedin_url,photo_url,answers,checked_in,owner_id,status,score,priority,reasons,missing_fields}]}]}`. No source IDs/emails/private evidence in dashboard. Assignments shared across audiences. Ingest retains owners, existing immutable professional identity and cohort; new source attendees don't silently expand cohort. `initial=True` freezes the first approved roster. Reruns reject changed identities/missing guests or backwards revisions.

## Server

`event_crm.server.serve(config,host='127.0.0.1',port=8765)`. Framework-free Python standard library. UI assets inside event_crm/static. GET /api/dashboard, GET /api/status, POST /api/assignment. Server authoritative Store; no arbitrary file serving. Default localhost requires access token too. EVENT_CRM_VIEW_TOKEN for read-only, EVENT_CRM_TEAM_TOKENS JSON mapping team IDs to opaque write tokens. Browser login exchanges token in POST body for HttpOnly SameSite=Strict cookie; no token URLs/localStorage. Nonloopback requires explicit trusted TLS proxy mode; requests/origin/CSRF guard. UI no external fonts/scripts. Show stale/ended, never reset attendance on error. 15-second dashboard refresh. Filters audience/search/owner/attendance + exact signup-answer chips when available; rank priority, then value/attendance per config. Include shared assignment/status controls for authorized team only. No UI mutates provider check-ins.

## CLI

`python -m event_crm`: `demo`, `init`, `doctor`, `research`, `sync`, `ingest`, `serve`, `monitor`, `verify`, `assign`. Paths explicit and relative config. Monitor finite deadline; no daemon auto-install; Partiful agent browser poll separate and accepts normalized file. CLI loop only supports Luma (or watching new Partiful snapshots without claiming browser automation).
