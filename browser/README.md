# Partiful visible-table adapter

The reader observes an authorized host's existing Partiful Manage Guests table. It reads explicitly mapped professional fields and explicit check-in controls in both Approved and Can't Go views. It produces the normalized private snapshot accepted by `python -m event_crm ingest`. Attendance is independent of RSVP status. The reader never clicks a guest check-in control.

`partiful.mjs` contains pure validation, a framework-neutral traversal, a Codex tab adapter, and a Playwright-compatible adapter for browser tools that expose an authorized existing Page. There are no dependencies, browser launchers, cookie readers, session extraction, private API calls, or background browser processes. Python's CSV importer is the supported alternative when the visible table or browser tool cannot provide the required evidence.

## Browser tool setup

Complete the repository's host onboarding first. Read the installed browser tool's instructions and initialize its documented runtime. Select the host's already authenticated event tab through that tool. Open the full Manage Guests table with no search or additional filters. The URL must exactly match `config.event.url`, optionally followed only by Partiful's UI focus hint `?focus=guest-table`; tracking parameters and a different event are rejected. Snapshot identity always uses the configured canonical URL without that hint. The configuration must contain the three explicit authorization confirmations, exact professional `fields` labels, and the allowlisted `questions`.

For a Codex tool that provides the documented `tab.playwright` and `tab.scroll` facade, load the module in that tool's supported JavaScript runtime, then invoke:

```js
const adapter = createCodexAdapter(tab, config);
const snapshot = await captureAttendance(adapter, config);
```

For Claude Code, use its authorized browser tool only if that tool provides an existing Page-compatible handle with `url`, `reload`, `getByRole`, `getByPlaceholder`, `locator`, `screenshot`, and `mouse.move/wheel`, and supports the DOM evaluation shown in this module:

```js
const adapter = createPlaywrightAdapter(authorizedExistingPage, config);
const snapshot = await captureAttendance(adapter, config);
```

The Page handle must come from the browser tool's documented mechanism. This repository does not connect to arbitrary debugging ports, load browser profiles, start Playwright, bypass the browser tool, or assume that all Claude browser tools expose JavaScript handles. If its capabilities differ, implement the small adapter interface below using that tool's documented visible-UI operations. If the tool cannot support it, use a host-exported CSV instead. Follow that tool's rules for reading the module and privately saving the resulting JSON; do not print the guest list into shared logs. Feed the complete JSON to the normal CLI ingest path. Do not edit the live database directly.

## Exact mappings

`fields.company`, `fields.title`, and `fields.linkedin` identify exact table header labels. Include only fields the event collects; absent mappings produce empty professional evidence. `fields: {}` and `questions: []` are allowed. A configured header that is missing from the actual table is an error. Each `questions` entry maps an internal answer ID to one exact professional header label. Unmapped columns are never read, even if they are present in the table. Contact, immigration, and other sensitive questions are rejected as mappings; a label check supplements the host's required professional review and is not a substitute for it. Email addresses and recognizable phone numbers embedded in otherwise permitted text are redacted.

Optional `partiful.columns` maps the control names `guest`, `status`, `check_in`, `plus_ones`. Defaults are `Guest`, `Status`, `Check in`, `Plus Ones`. The plus-one header is validated but its cell contents are never copied or interpreted. Optional `partiful.count_labels` maps `approved` and `cant_go`, defaulting to `Approved` and `Can't Go`. Each count must be represented by one exact button label `NUMBER LABEL`. A missing badge is unknown, including when a zero badge is hidden; the standard adapter then fails closed. A custom adapter may supply a zero only from an explicit visible provider signal. The built-in view controls use Partiful's English Approved/Can't Go labels and reviewed emojis. A changed/localized UI requires a reviewed adapter change.

## Traversal and evidence

Every view must provide stable counts and table extent, contiguous virtual row positions from zero, and a consistent exact row height. All rows must fit the complete header-plus-rows extent using only browser pixel rounding. Overlapping pages must agree on every field. Identity is SHA256 of the UTF-8 JSON array `[exactEventUrl, displayName, linkedinUrl, company]`, with no JSON whitespace; display text is trimmed and `No response` becomes empty. Same-name people remain distinct when LinkedIn or company differs. An identical professional identity at two positions fails; no name-based joining is attempted.

Optional LinkedIn profile answers use the same tested normalizer in Python and JavaScript: supported root, www and two-letter regional LinkedIn hosts become `https://www.linkedin.com/in/<slug>`, missing schemes become HTTPS, and share queries/fragments and trailing slashes are removed. Invalid or non-profile answers become empty evidence rather than aborting a complete scan. The normalized profile is part of the exact identity: a later substantive profile change still requires review, not fuzzy matching. Partiful has no calendar ID; config and snapshots use null or an empty value, and nonempty calendar IDs are rejected.

The badge may exceed the complete named table; its difference is never assigned to individual guests. `source_counts` contains named rows and partitions the snapshot. `source_evidence` separately records stable badge counts and the complete named-table extent for each view. A badge smaller than the verified named row count is rejected. An explicitly zero-count, fully observed empty view is accepted. Any missing range, moving identity, duplicate, changed check-in, unexpected control, changed header, or changed count aborts the scan and returns no publishable snapshot.

The provider does not promise an atomic view across an entire scroll. The reader detects observed inconsistencies and records the scan interval, but cannot detect an unobserved change that occurs after a row scrolls out of view. The database preserves the last complete snapshot when a scan fails. Offline synthetic tests verify reader logic and facade wiring; they do not certify a current authenticated live DOM.

## Custom facade

`captureAttendance(adapter, config, {maxPages: 400, onEvidence, includePhotos: false})` calls these methods:

| Method | Result or operation |
| --- | --- |
| `url()` | Exact current event URL |
| `reload()` | Reload the selected tab |
| `prepare()` | Wait for Manage Guests and clear guest search |
| `readHeaders()` | Exact ordered table header strings |
| `readCounts()` | `{approved: integer, cant_go: integer}` from visible UI |
| `selectView(view)` | Select `approved` or `cant_go` using visible controls |
| `readRows(columns)` | Only fields returned by `readVisibleRows` |
| `measure()` | `{top,height,view,headerHeight,point:[x,y]}` |
| `scroll(state,direction,pages)` | Native visible scroll at table point |
| `observe()` | Native screenshot/render observation |

An optional `onEvidence` receives aggregate geometry only. Neither it nor error messages contain guest answers. The reader is one finite scan. A host-authorized agent may repeat scans within the configured monitoring window and ingest each result; the Python file watcher by itself does not drive a browser. Keep polling at or above the configured interval and stop at the configured end. Provider check-in mutations remain outside this adapter.

`includePhotos:true` is a separate preflight option: it reads only the visible guest-cell image URL as an untrusted portrait hint. Default attendance scans do not inspect image URLs. Hints are excluded from overlap/attendance comparisons, never downloaded by the reader and never approve identity. Initial ingestion can retain a safe unsigned hint for the private photo plan; later attendance ingestion does not update portraits. Follow the portrait workflow in `START_HERE.md` for identity review, fallback discovery and private caching.

Official Partiful references: [guest check-in](https://help.partiful.com/en-us/articles/15525408-how-can-i-check-in-guests-for-my-event), [CSV export](https://help.partiful.com/en-us/articles/15525376-how-can-i-export-my-guest-list), [display-name limitations](https://help.partiful.com/en-us/articles/15525419-can-i-download-the-names-of-my-guests). These document host capabilities; they do not specify DOM selectors or a public guest API.

## Luma and CSV semantics

The Python adapter uses the [official public OpenAPI schema](https://public-api.luma.com/openapi.json) and [calendar API-key authentication](https://docs.luma.com/reference/getting-started-with-your-api). It verifies the key's calendar, exact event ID/URL/calendar, and `access: manage`; reads every guest page; and checks status counts and mapped question definitions before and after traversal. All requests are GET to the canonical API origin. Redirects are refused before credentials are forwarded. API keys come only from `LUMA_API_KEY`.

Map each professional field to the exact `registration_questions[].label`. Answers must match that question's ID, label, and type. A built-in `company` question stores an object; mapping both `fields.company` and `fields.title` to its same label selects `value.company` and `value.job_title`, respectively. Do not map it again as a freeform answer. No fallback to arbitrary profile properties or contacts is performed. Missing professional answers are empty evidence.

Luma attendance comes only from `event_tickets[].checked_in_at` nested under the exact guest ID. One ticket gives true for a valid timestamp and false for explicit null. Missing ticket state, no tickets, or multiple tickets produce unknown. The schema does not establish `EventTicket.name` as a person's name, so it is never used for identity matching. Group registrations cannot establish which named person arrived. A malformed timestamp or duplicate ticket aborts. A virtual meeting join, RSVP, or ticket purchase never establishes attendance. Luma may change during pagination; stable counts do not prove a transactional point-in-time export.

CSV is a host-supplied complete event export, never continuous live access. Its file has no independently verifiable event binding: the authorized host is responsible for exporting the exact configured event and all required RSVP views. Exact `csv.id`, `name`, `checked_in`, `approval_status` mappings default to `source_id`, `name`, `checked_in`, `approval_status`. Professional columns use the same `fields` and `questions` labels. Contact columns are discarded. Attendance accepts only literal lowercase `true`/`false`; empty, `null`, and `unknown` remain unknown, and all other spellings require an explicit source conversion. RSVP status values must use the normalized vocabulary in the contract. Partiful imports compute the same identity and do not need a source-ID column. Captured time must be supplied explicitly. Initial roster import can retain unknown attendance; subsequent attendance updates require an explicit boolean for every existing tracked person.

Run offline checks with Node.js 22+ using `node --test browser/partiful.test.mjs` and `python -m unittest discover -s tests -v`. Tests use synthetic values only, including a complete JavaScript capture validated by the Python importer.
