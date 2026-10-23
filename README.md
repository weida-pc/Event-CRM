# Event CRM

Know which high-value prospects are checked in, why they match your business, and who on your team owns the conversation.

Event CRM combines host-approved ideal customer profiles (ICPs), professional signup answers, recorded attendance, and persistent team assignments. Real guest data is private; public source code and demos contain fictional examples.

Two independent runtimes share this repository:

| Runtime | Provider access | Research and hosting |
| --- | --- | --- |
| `cloud/` customer-facing product | Luma calendar API key and event link | Automatic, budgeted website/profile/portrait research; Cloudflare Workers and isolated SQLite Durable Objects; separate sponsor access scopes |
| `event_crm/` agent-assisted toolkit | Luma, authorized Partiful browser, or CSV | Human/agent-reviewed research; a private Python/SQLite server |

The [hosted Luma beta](https://event-crm-luma.event-crm-cloud.workers.dev) accepts a calendar-admin API key and managed event link. Partiful remains available in the independent toolkit and is not offered as a hosted login. Self-hosted copies require their own explicit deployment and credentials.

## One link for any agent

Give Codex, Claude Code, or another capable coding agent the link to **[START_HERE.md](START_HERE.md)** and say:

> Set up Event CRM for my event. Read this entire guide first. Tell me which authorizations and credentials you need before accessing anything. Research my business website, propose the ICP and scoring rules for my approval, then set up the private dashboard and bounded attendance monitoring. Never change provider check-ins or send outreach.

The guide is the single onboarding entry point. `AGENTS.md` and `CLAUDE.md` route both agents to the same workflow. Nothing depends on a particular company, machine, event roster, VM, or agent vendor.

## Hosted product

The host confirms the exact managed event, professional fields, business websites and research purpose. Website-derived ICP proposals include source excerpts; the host reviews the rules and complete roster before launch. Each audience has its own ranking and question scope. Sponsor keys require a mapped sharing opt-in and never expose the host's research or other audience answers.

Automatic research distinguishes corroborated identities, candidates, unavailable sources and unresolved portraits. It uses named original sources, not face matching or generated portraits. Portrait container validation, private caching and browser load counts are separate checks; no system can guarantee a photo exists or is retrievable everywhere online.

Saved snapshots and assignments live independently of polling. Bounded alarms validate complete source pages before publication; failures retain the last good data. Named team keys, backup owner keys, encrypted Luma credentials, revocation and a retention deadline define workspace access. There is no billing system, email sender or email-based account recovery.

The operator configures Bright Data or Serper plus Gemini in Worker secrets. Conservative shared reservations bound research spending. These estimates do not cap unrelated usage of shared provider accounts. The product has explicit guest, field, audience, monitoring-window and admission limits; it is a bounded beta rather than an unlimited public service.

## Agent-assisted toolkit

- Uses the host's business email domain to find a candidate website; researches observed product/customer pages without transmitting the full email. A human confirms the company and proposed ICP.
- Scores professional evidence with configurable, explainable rules. Value-first is the default; priority groups can always remain above or below other groups regardless of attendance.
- Adds filter buttons for configured signup questions with available answers. Each audience can have its own rules and cutoff.
- Reads Luma's official API or an authorized Partiful host browser; never treats RSVP as attendance. Incomplete scans preserve the last good state.
- Gives every lead a stable owner and shared work status. Team changes persist in SQLite independently of attendance updates.
- Accounts for portraits across the agreed cohort, with private event/profile/official-page/search work lists, identity evidence, authenticated image caching, visible rendering coverage and explicit unresolved guests. Search results lead to reviewed original sources, never automatic thumbnail matches.
- Serves an authenticated, mobile-friendly dashboard with read-only and per-member team access. Real guest data is private by default.

## Quick synthetic demo

Python 3.11+ is sufficient; no pip dependencies or provider keys are required.

```sh
python -m event_crm demo --directory runtime/demo
python -m event_crm verify --config runtime/demo/event.json
```

To open the dashboard, set a strong `EVENT_CRM_VIEW_TOKEN` in your process environment and run:

```sh
python -m event_crm serve --config runtime/demo/event.json
```

Open `http://127.0.0.1:8765`, then sign in with that token. The demo is synthetic and does not poll real events. [START_HERE.md](START_HERE.md) includes Windows/Linux commands, team tokens, provider setup, monitoring and TLS hosting.

## Architecture and limits

Provider adapters produce an event-bound, allowlisted snapshot. A transactional private store freezes the reviewed cohort and joins later check-ins by exact identity. Separate audience rules produce ranked views; assignments are shared across those views. The browser polls the authenticated dashboard every 15 seconds; provider scans normally run every 60 seconds.

Luma monitoring can run in a normal bounded Python process. Partiful requires a browser-capable agent with host-authorized access; this repository does not supply a universal browser tool or undocumented Partiful API. CSV imports are point-in-time snapshots, not real-time connections. Registration field layouts must be mapped explicitly. Website-derived fit is a hypothesis for review, not verified purchase intent or a revenue prediction.

Attendance updates are all-or-nothing: one missing, changed or attendance-unknown tracked identity pauses the entire feed and preserves its last good state. Luma group registrations and registrations without explicit ticket state need particular attention during the host-authorized preflight. Offline tests do not certify a live provider account or current browser layout.

The Python toolkit uses one private state directory per event. Run separate instances for separate events. Unlike the Cloudflare product, its audience tabs are not security boundaries and its research is agent-assisted. It does not make paid enrichment calls or provision public-cloud resources.

## Verification

```sh
python -m pip install ".[photos]"
python -m unittest discover -s tests -v
node --test browser/partiful.test.mjs
node --test tests/photo_ui.test.mjs
python -m compileall -q event_crm
python tools/privacy_check.py
```

Tests use synthetic data and fake provider responses. Live provider access must be preflighted with the host's own authorization and account. See [SECURITY.md](SECURITY.md) for the trust model.

Portrait preparation and image-validation tests in the toolkit use the optional Pillow dependency (`.[photos]`); the core Python demo and attendance service remain standard-library-only. The toolkit does not call paid enrichment services. The hosted product's separate synthetic suite is `cd cloud && npm ci && npm test`; its tests never call real providers.

[examples/ci-tests.yml](examples/ci-tests.yml) is an optional Windows/Linux GitHub Actions template. A repository owner can install it at `.github/workflows/tests.yml` with credentials authorized to manage workflows. It is not active by default; the commands above run all checks locally.
