# Hosted Luma release review — 2026-10-23

## Review evidence and disposition

Plan and implementation reviews were received from Claude Code **Opus 5.5, Max effort**, and Gemini **Argon, High thinking**. Implementation review covered public source and fictional fixtures at commit `145f54b`; the fixes below were subsequently regression-tested. No real attendee data or credentials were included in either review packet.

Accepted findings addressed in this release:

- Server-side sponsor canonical-field allowlists; current sharing consent on every successful complete scan; failed validation closes scoped sharing while preserving the host snapshot.
- Independent sponsor assignment namespaces, safe base-workspace login for scoped keys, and per-key session pruning/revocation.
- Exact, unique named-image attribution and independently corroborated identity before portrait caching; original images instead of search thumbnails; lightweight image-hash indexing instead of loading every image blob.
- Biography retries retain the failed candidate; image links are parsed before contact redaction; extracted biography facts must identify the subject; AI-proposed rules use the same validator as host rules.
- Pending edits lock selectors as well as buttons; unselected questions cannot remain in a sponsor scope; new registrations are visible as a review count; team members see research progress.
- Reconnection clears obsolete errors; roster adoption preserves active monitoring; retention is bounded from workspace creation.
- Moving-source failures retain strict validation without exponential delay; oversized optional answers are explicitly omitted instead of blocking the whole attendance feed. Identity is never silently shortened.
- Separate authenticated ingress and background capacity limits, one-minute browser refresh, lifetime workspace research reservations, and value-ranked research queues.

Recommendations not accepted literally:

- Partial publication on identity/count drift would weaken the complete-source guarantee. The last-good snapshot remains authoritative until a complete scan or explicit roster review succeeds.
- Workers Free's 10 ms request limit does not describe Durable Object CPU. Cloudflare documents 30 seconds by default for DO invocation CPU and one active alarm execution per object. A second generic alarm mutex is therefore not added. In-flight generation checks remain.
- Static security headers were already present in `public/_headers`; they require live HTTP verification, not a duplicate implementation.

Primary references: https://developers.cloudflare.com/durable-objects/platform/limits/ and https://developers.cloudflare.com/durable-objects/api/alarms/.

## Verification boundary

- Cloud suite: 49 tests, including a 500-person multilingual snapshot bound, synthetic Workers lifecycle, cross-workspace authorization, consent revocation, assignment scope, disconnect races, resource exhaustion, lifetime budget and final-scan retention.
- Independent toolkit: 164 Python tests and 31 JavaScript tests.
- Browser: synthetic full setup, website ICP proposal/application, roster preview/launch, ranking/filtering, assignment/follow-up persistence, pause/reload and disconnect/reload. Live fictional demo supports distinct sponsor ranking and filters.
- Live public-provider preflight: Bright Data search, page and image results, plus Gemini structured extraction succeeded using small public inputs. No Apify calls or plan upgrade.
- Real Luma event integration is not certified by fictional fixtures. It still requires a host-authorized Luma Plus calendar-admin key and exact managed event during onboarding.

## Deployment verification

Worker `event-crm-luma` version `10bc1526-25d5-484f-a518-305602ece72e` is deployed at https://event-crm-luma.event-crm-cloud.workers.dev with admission open. Root, demo, privacy and health return HTTPS 200 with security headers. The health endpoint reports Luma/open. Live browser signup reaches the authenticated Luma connection form. Owner login, backup login, logout/session invalidation, unauthenticated rejection and cross-origin mutation rejection passed against the deployed API. The empty test workspace was deleted and subsequent access returned 404. No real Luma event was connected by this verification.

Cloudflare Free plan, app-enforced $40/month research reservation and $15 lifetime per workspace apply to this app. Shared-account activity outside the app is not controlled by its ledger. Daily capacity limits can pause processing; saved data is retained, and freshness/error indicators must be honored. This is a bounded beta, not unlimited capacity or guaranteed portrait coverage.
