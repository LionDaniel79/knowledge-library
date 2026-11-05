# Desktop library transition implementation plan

> Execute the approved specification with superpowers:subagent-driven-development. Independent desktop engine, cloud API, and Logos tasks have isolated file ownership; root integrates UI, data-retention safety, packaging and acceptance.

**Goal:** Complete the user's seven-point split plus bulk import, background OCR and location reconciliation.
**Architecture:** Native WPF/Python with a new private management DB overlays the preserved read-only legacy index. Outbound authenticated HTTPS transfers selected bibliography/location changes only. Existing web sync and managed images are reused.
**Tech stack:** WPF/.NET Framework, Python/PDFium/Windows OCR/SQLite FTS, Next/TypeScript/Postgres, PGlite/Playwright.
**Spec:** ../specs/2026-11-04-desktop-library-transition.md (user approved 2026-11-04).

## Constraints and review focus
- Preserve original PDFs, legacy SQLite/OCR, IDs, personal records and unsent device changes.
- No HTTP listener in the new Windows app. Do not retire the old installation until its replacement passes.
- Identity by file content, never title-only; preserve independent legacy IDs and multiple copies.
- Offline/disconnected scans cannot authorize delete; current selection is not proof of a complete scan.
- Stored covers must render after the remote host disappears; ambiguous Logos editions remain reviewable.
- No new registrations override manual exclusions or purge tombstones. Location changes must not reset notes.
- Real permanent purge requires a concrete target list, verified backup and final approval; implementation and isolated testing continue autonomously.

## Task A — Windows management engine
- [x] Add failing synthetic tests for initial/no-legacy import, incremental/moved/duplicate PDFs, new private DB, stable IDs and legacy reuse.
- [x] Implement management.py: scan/status/search/render, durable page queue/OCR step/pause/retry, selected-root batches/location audit and retryable HTTPS outbox.
- [x] Prove cancellation/resume, disconnected roots, safe paths and no original writes. Run existing desktop/API and new tests with documented OCR Python.

## Task B — HTTPS registration and location API
- [x] Define strict schema and tests: owner/device/scope, first registration/server ID, retry/fingerprint/no-op, optimistic versions, exclusions/tombstones, root-relative path validation.
- [x] Implement API and non-destructive mapping schema036; no new replica entity. Existing v2 manifest stays compatible.
- [x] PGlite and route tests; document versions/lastCheckedAt semantics and complete-scan reconciliation.

## Task C — Logos enrichment and persistent covers
- [x] Failing tests for persisted bytes, stale/owner/exclusion, digital-edition match and ambiguous title candidates.
- [x] Implement atomic managed-image storage and provenance migration037; use existing providers/quota/cache, durable batch work.
- [x] Preserve resource IDs/licenses and all unconfirmed metadata; focused cover/Logos/catalog and batch tests.

## Task D — Web retirement and metadata-only display
- [x] Browser regressions: PDF menu/reader actions absent, books/notes/search preserved, locations displayed safely.
- [x] Remove the main-app PDF UI dependency, retire legacy reader/HTTP endpoints without touching Python OCR helpers used by Windows.
- [x] Route old entry links safely; remove PC-origin/login handoff configuration from web startup.
- [x] Update affected tests to the intended retired behavior rather than masking failures or adding skips.

## Task E — Windows usable application and installer
- [x] WPF controls for first scan/incremental import/OCR pause/retry/progress/audit/web batches and windowless native background/tray.
- [x] Separate process lifetime from one-shot search cancellation, durable jobs; original data unchanged.
- [x] First-user setup and safe local shortcut/config, current-device token DPAPI reuse, no plaintext keys or guessed server IDs.
- [x] Build/synthetic WPF search/page/cancel/queue/tray smoke; real read-only audit only after isolated tests pass.

## Task F — Actual bibliography cleanup and release
- [x] Read-only concrete preview for outside-root PDFs: classify references/mixed formats/duplicates/exclusions, blocked reimport identity and sync tombstones. Restored-copy preview5173 eligible/40 held; exact private review list generated.
- [x] Implement guarded hard-purge only for reviewed unreferenced records; held references retain notes/history and are reported, never silently detached.
- [x] Extend backups for new non-secret business data; fresh encrypted QA/production archives restored and verified2026-11-05 before live changes.
- [x] Full tests, focused independent reviews, preview deployments/QA; batch checkpoint pushes to avoid repeated CI billing. Web851/browser304; native97 passed/one privilege skip; OCR quality31 and pipeline19; real image-only installed OCR; actual QA registration/replay/location/no-op and exact fixture cleanup passed.
- [ ] Apply safe approved deployment/registration steps. Ask only for destructive target approval or actual user-secret entry; record all NOT_RUN honestly.
- [ ] Retire legacy server/autoruns only after replacement installed and validated; finish read-only mobile acceptance with minimal user assistance.

## Baseline
Clean isolated worktree at c09137b; Vitest805 + four conditional tests, Playwright332, Python24 + PDF/OCR42, web/WPF builds passed earlier this session. Do not repeat unchanged broad baselines before each independent task. Remote GitHub CI is allowance-blocked; no repeated retries or budget changes.

## 2026-11-05 verified milestone
- Web845 tests passed; four pre-existing environment-dependent tests not run. Browser304 tests passed after removing retired original-search UI tests (no new skips).
- Desktop70 Python tests passed; WPF overlay/no-index and setup/DPAPI/tray/watcher smoke passed. Web production build/typecheck/format passed.
- Independent review identified and tests fixed routine CAS recovery and broken-cover batch starvation; no remaining identified P1/P2.
- New QA036–039 migrations applied after verified backup. Production business records unchanged. QA65/production59 tables restored into independent encrypted local PostgreSQL with all contents/schema checksums matching.
- Actual read-only inventory9319 PDFs; selected roots4109 physical. Existing index9321 documents all have SHA-256, so relocation identity can reuse originals. Old path absence is not file deletion.
- Logos source2620 rows ->2418 eligible; production read-only preview2412 new/6 possible existing editions; no import yet.
- Remaining release tasks: commit/preview HTTPS verification, install new desktop alongside old installation, actual full scan, production schema/release and selected registration, reviewed web-only purge target/approval, old server retirement after replacement validation.

## Additional verified checkpoint
- PR9→8→7 merge and existing web release completed under explicit approval. New split PR10 remains draft and is separate from the actual production data transition.
- Actual full inventory/SHA comparison, native installation, QA HTTPS acceptance and verified encrypted state backup completed. Schema3 migration was first proved on a copy, preserving content/OCR/queue/request identities and resolving all4108 selected legacy identities after a cached rescan.
- Shared-content logical book identities and the previous300dpi body/footnote quality profile are preserved in the native worker. Fatal engine failures pause rather than poison the queue; installed raster OCR and upgrade-state preservation are now explicit acceptance gates.
- Concrete private cleanup list:5173 outside-root web records;40 held; generated revisions30815, unconfirmed generated memberships15296 and bulk exclusions5173 included in reviewed scope. Operational execution still requires final approval.
