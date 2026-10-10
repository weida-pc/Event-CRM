# Portrait workflow review

## External review

Claude Code reviewed the initial portrait patch with `claude-opus-5-5`, effort `max`, in a read-only, tool-disabled invocation. It completed successfully and did not execute tests or modify files. Its verdict was not ready to ship; the findings below were addressed before release. This is a record of review and remediation, not a claim that the model approved the final revision in a second pass.

## Findings and dispositions

- JPEG decoding: optional animation properties use a safe default. JPEG, PNG and WebP round-trip tests cover all supported formats.
- Dependency and decoder failures: missing Pillow fails before network access/writes. Decoder exceptions are isolated as validation failures; corrupt PNG CRC and EXIF failures exercise the fallback path. Only the declared image-format parser is enabled.
- Rerun accounting: source checks/reasons/outcomes survive plan regeneration; unchanged entries do not bump revisions. Existing edited plans require explicit replacement. Windows BOM input works and duplicate JSON keys fail.
- Rejection ordering: revocations precede searches, independent of alias order. Tests cover correcting an image assigned to another tracked person.
- Revocation resilience: sizing-independent source URLs, original source-byte hashes and thumbnail hashes are retained. No claim of perceptual or facial matching is made.
- Data deletion: SQLite secure deletion is enabled. Backups/filesystem snapshots still need an operator retention policy.
- Diagnostics and source evidence: candidate validation identifies alias/index; signed profile-media URLs are explicitly blocked. Event-avatar canonical binding versus the observed host-management page is explained in setup.
- Poll isolation: photo hints use a standard-library-only URL validator, without decoder imports or DNS access. Research retains its default same-site/no-query constraints; only portrait fetches allow vetted cross-site redirects and allowlisted sizing parameters.
- UI/efficiency: the summary does not announce every image load to screen readers, shows pending/failure counts, and reuses unchanged image nodes. Plan/report queries do not load image BLOBs; the CLI reuses the apply result instead of regenerating it twice.

## Verification

The final local checks pass: 155 Python tests, 31 Node tests, Python compilation, JavaScript syntax checks, Pyflakes and the release privacy scan. Tests are synthetic and make no paid enrichment calls. Coverage includes authenticated HTTP image serving and exact HTTPS publication-byte checks using controlled responses. The actual shipped UI code is exercised in an offline DOM harness, including image success/failure and refresh reuse.

Real-browser visual verification remains unperformed: the available browser tool's Chrome session blocked the local test origin. No live host account, attendee data, production deployment or provider layout was tested. The operator must complete authenticated browser and deployed-origin checks from `START_HERE.md` before claiming a live event is ready.

## Upgrade behavior

Legacy external `photo_reviewed` images are discovery hints, not accepted cached assets. They stop rendering until reviewed and cached through the private workflow. Existing attendance, cohort definitions and team work remain unchanged. Unavailable portraits keep initials and appear in the private coverage report.
