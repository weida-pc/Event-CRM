# Event CRM

Know which high-value prospects are checked in, why they match your business, and who on your team owns the conversation.

Event CRM is a self-hosted, private lead dashboard for **Luma and Partiful** events. It combines host-approved ideal customer profiles (ICPs), relevant signup answers, recorded attendance, and persistent team assignments. It is an agent-assisted toolkit, not a hosted SaaS or a promise of automatic access to every provider account.

## One link for any agent

Give Codex, Claude Code, or another capable coding agent the link to **[START_HERE.md](START_HERE.md)** and say:

> Set up Event CRM for my event. Read this entire guide first. Tell me which authorizations and credentials you need before accessing anything. Research my business website, propose the ICP and scoring rules for my approval, then set up the private dashboard and bounded attendance monitoring. Never change provider check-ins or send outreach.

The guide is the single onboarding entry point. `AGENTS.md` and `CLAUDE.md` route both agents to the same workflow. Nothing depends on a particular company, machine, event roster, VM, or agent vendor.

## What it does

- Uses the host's business email domain to find a candidate website; researches observed product/customer pages without transmitting the full email. A human confirms the company and proposed ICP.
- Scores professional evidence with configurable, explainable rules. Value-first is the default; priority groups can always remain above or below other groups regardless of attendance.
- Adds filter buttons for configured signup questions with available answers. Each audience can have its own rules and cutoff.
- Reads Luma's official API or an authorized Partiful host browser; never treats RSVP as attendance. Incomplete scans preserve the last good state.
- Gives every lead a stable owner and shared work status. Team changes persist in SQLite independently of attendance updates.
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

One event configuration uses one private state directory. Run separate instances for separate events. This release does not include billing, an email sender, an automatic paid enrichment service, per-audience security isolation, or automatic public-cloud provisioning.

## Verification

```sh
python -m unittest discover -s tests -v
node --test browser/*.test.mjs
python -m compileall -q event_crm
python tools/privacy_check.py
```

Tests use synthetic data and fake provider responses. Live provider access must be preflighted with the host's own authorization and account. See [SECURITY.md](SECURITY.md) for the trust model.

[examples/ci-tests.yml](examples/ci-tests.yml) is an optional Windows/Linux GitHub Actions template. A repository owner can install it at `.github/workflows/tests.yml` with credentials authorized to manage workflows. It is not active by default; the commands above run all checks locally.
