# Event CRM agent instructions

Read [START_HERE.md](START_HERE.md) for the complete installation and host onboarding procedure. Claude Code uses the same procedure via CLAUDE.md.

- This is an independent, provider-neutral project. Only synthetic examples and tests belong in Git. Do not copy customer event data, credentials, internal domains, machine paths, company-specific scoring rules, or previous repository history.
- Provider access is read-only. Never approve guests, change check-ins, send messages, read session tokens, or use undocumented authenticated APIs.
- Require host authorization, exact event binding, explicit professional-question mappings, approved ICP evidence, team members, and a bounded monitoring window before live operation.
- Attendance requires an explicit provider check-in signal. Missing data is unknown, never absence. Complete source validation and exact identities precede atomic updates. Preserve last good data on failure.
- Keep assignment and attendance state independent of scoring and rerenders. Provider snapshots cannot overwrite team work.
- No credentials in URLs or committed files. Public code does not imply public guest data; runtime is private by default.
- Test using synthetic fixtures only: `python -m unittest discover -s tests -v` and `node --test browser/*.test.mjs`. Never use real event credentials during tests.
- Code edits use apply_patch. Preserve unrelated user changes. Do not deploy or start monitoring a real event as a side effect of developing this project.
