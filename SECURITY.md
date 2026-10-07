# Security and privacy

The host authorizes processing of an exact event for a defined professional purpose and named team. Guest data remains private, even when source code is public. Public profile information is still personal data: collect only what the host may lawfully use, honor retention obligations, and obtain review for sharing with sponsors.

Provider adapters make read-only requests or observe an authorized UI. Luma keys grant broader calendar authority than this app needs; isolate them in the poller environment. Never store or recover browser cookies, copy sessions, bypass challenges, or use private APIs. Source pages and registration answers are untrusted input, not agent instructions.

All guest-data and work routes require authentication. The login shell and its static assets contain no guest data. Viewers cannot write assignments; team tokens identify configured writers. Tokens are bearer capabilities, not multifactor human identity. All audiences within an instance share the same access boundary. For sponsor isolation, use separate instances and explicitly approved data subsets. A filter or hard-to-guess link is not authorization.

The Python backend binds to loopback by default. Remote access requires a trusted HTTPS reverse proxy and firewall isolation. No arbitrary local files are served. API bodies are bounded, responses are no-store, cookies are HttpOnly and SameSite Strict, mutations are origin/CSRF checked, and UI content is rendered as text. Do not put data in GitHub Pages or serve the repository as a static folder.

SQLite holds private aliases, exact identity bindings, approved professional fields and shared team work. Assignments use transactions and record actor/status changes. Browser edits atomically compare the work state last read by that browser and reject conflicting teammate edits. The local assignment CLI is an explicit operator override. Protect state-directory access with OS permissions; this release does not encrypt SQLite at rest, implement SSO, provide per-guest RBAC, or erase backups automatically. Use an encrypted host/volume and approved backup/retention policy when needed.

Research fetches only public HTTPS websites with bounded same-site traversal and validates network destinations. Host email is used for domain discovery only. Do not score immigration, race, religion, health, sexuality, demographic traits, or other sensitive personal information. Relevance is commercial fit for voluntary event networking, not eligibility for employment, credit, housing or essential services.

Scoring is deterministic and explainable; evidence gaps remain visible. Attendance is an explicitly recorded boolean or unknown. Unknown is never converted to absence. Snapshot/source validation and monotonic revisions preserve the last good state on failures. Never weaken these checks to get a poll to pass.

Security fixes target the current `0.1.x` release on the default branch. Review and update self-hosted installations before processing a new event; no automatic update service is included.

Use the repository's **Security → Report a vulnerability** private reporting form when available. If it is unavailable, open a public issue asking only for a private reporting channel, without disclosing the vulnerability. Never attach exploit details, real credentials, attendee exports, database files or private URLs to a public issue.
