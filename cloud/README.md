# Event CRM hosted Luma product

This directory is an independent Cloudflare Workers application. It does not import, deploy or modify the Python toolkit or any external VM service.

`public/` contains the dependency-free UI and fictional demo. `src/worker.mjs` handles routing and request boundaries. `Workspace` owns one event's encrypted calendar credential, approved configuration, complete snapshots, team assignments, scoped keys, research and retention. `Control` owns admission, provider throttles and conservative research reservations. Each workspace's alarm advances bounded, separately persisted attendance and research steps. All storage is private SQLite Durable Objects; there is no public guest bucket.

Luma uses documented read-only GETs. Bright Data or Serper supply public search/page results; Gemini extracts evidence and proposes ICP rules. Untrusted inputs become text, not HTML or instructions. Portrait attribution refers to original named sources; bounded raster containers are validated, metadata is removed and images are served behind workspace authorization. Rendering coverage is reported separately.

The full setup, authorization, credentials, budget, deploy and host procedures are in the **Cloudflare product** section of the repository's single entrypoint, `START_HERE.md`. `npm test` exercises synthetic source and Workers-runtime fixtures; `npm run check` bundles without publishing. `node test/local-server.mjs` runs an explicit synthetic-only local UI harness, never a production backdoor.

Admission is closed by default. A successful local build does not certify live provider access, public deployment, complete portrait coverage or a completed external review.
