# Desktop-library transition verification — 2026-11-05

Implementation branch: `feat/desktop-library-completion`, base `c09137bfad05e63fa72223bf489fdd9af9bfdfee`.

## PASS
- Web unit: 851 passed; four existing environment-dependent tests not run.
- Browser: 304 passed. Retired PDF original/OCR UI tests were removed; replacement native and web-retirement tests run without new skips.
- Windows: 98 Python tests executed, 97 passed and one Windows symlink-privilege test skipped. The existing OCR quality/language suite31 and coordinator/recovery/priority suite19 passed separately.
- WPF legacy-overlay and first-user/no-index search, page rendering, cancellation, queue, folder watcher, tray, explicit Exit, setup, upgrade-state preservation and DPAPI smoke passed. An installed image-only PDF exercised real Windows OCR with the body/footnote quality profile and private-bundle imports.
- Production web build, TypeScript, formatting, and patch whitespace checks passed.
- Optional backup tables round-trip resource identity, deletion blocks, completed-scan evidence, source provenance and cover locations without auth secrets.
- Fresh AES-256-GCM archives restored to independent encrypted PostgreSQL18: QA65 tables and production59 tables. All table content/schema fingerprints and tested relations match. Private artifacts remain outside Git.
- QA migrations036–039 applied after verified backup. No existing book/note/PDF/OCR data changed.
- QA HTTPS acceptance: one synthetic registration, identical replay, location delta with stable book/document identity, and no-op applied0. Exact synthetic book/document cleanup passed; personal notes/reading cycles unchanged. The opaque replay guard remains.
- Schema2→3 migration on a copy of the actual native DB, followed by a cached scan, retained all content IDs, OCR pages, queue rows, locations and31 stored immutable request bodies. Selected legacy4108 IDs were recovered with zero unresolved copies and zero new file hashing.
- Installed native code `fe6b983472e95ca4ccd98103766f63e7f2f52380`: actual schema3 upgrade retained8451 content resources,9900 generated pages,207152 queue rows,9319 physical locations and31 immutable request bodies. The original legacy index size/mtime stayed unchanged. Background processing resumed and six real source pages had the quality profile at the subsequent observation.
- Independent identity review found two issues with attempted no-legacy bindings and weak location inference; both have dedicated passing regressions. The quality-helper integration regression was observed failing before wiring and passing afterward.
- Approved PRs9→8→7 merged; main `afafa5e7184c85014d5f5656f3766720a43ded39` deployed READY. Production home200 and unauthenticated private APIs401. The newer split changes remain separately reviewable in PR10.

## Implemented
- Native whole-library inventory, content identity, read-only legacy OCR reuse, new private OCR/FTS queue, pause/retry/resume and incremental HTTPS bibliography/location updates.
- Schema3 logical registrations preserve separate legacy book IDs, CAS state and immutable retries while sharing content/OCR. Strong file identity survives moves; ambiguous relationships are held rather than guessed.
- Existing 300dpi body/footnote OCR, deskew, language adaptation and repeated-margin filtering are reused. Bounded private layout caches avoid repeating global/section probes for every page.
- Fixed a missing installed Windows OCR helper and a DACL upgrade privilege error. Fatal engine failures pause with the page pending, rather than marking thousands of pages as content errors.
- Per-item unresolved identity quarantine, bounded same-identity version recovery, immutable retries and actual completed-scan snapshots. Disconnection never authorizes deletion.
- New web registration/scan APIs; manual edits and purge tombstones protected. PDFs, OCR text, hashes and local absolute paths never uploaded.
- Web original-search/OCR/PC UI removed; legacy endpoints return410. Bibliography, page references and safe relative storage locations retained.
- Logos source import and durable finite enrichment, protected digital-edition matching and managed-image storage. Bad cover images cannot starve subsequent work.
- Guarded web-only purge requires exact reviewed target versions, current complete manifest, verified backup evidence, and dedicated enablement. Personal references hold a record from deletion.

## Read-only inventory / preview
- Whole storage9319 physical PDFs; selected roots4109 (Christian3598, General511).
- Existing legacy index9321 documents; all9321 have SHA-256. Old path absence includes moved excluded material and is not a missing-file conclusion.
- Existing IDs9318 matched the whole physical inventory; selected legacy IDs4108 represent3676 shared content resources. Actual file/legacy SHA comparison found zero mismatches.
- Logos source2620; eligible2418, excluded202; permanent2246, temporary172.
- Production Logos preview:2412 new candidates, six potential existing editions held; applied=false.
- On an isolated restored production copy, guarded web-only cleanup allows5173 outside-root bibliography records and holds40 (37 classification reviews plus three missing/referenced records). The exact reviewed plan includes30815 recognized generated revisions,15296 unconfirmed generated topic memberships and5173 bulk-exclusion details. Unknown/manual references remain protected; no production purge was executed.

## NOT_RUN / remaining
- PR10 release and production schema changes; real selected-PDF/Logos registration and live provider coverage.
- Current production revalidation of exact cleanup targets, final destructive approval and execution. The PR9→8→7 merge/deployment approval explicitly excluded PDF/DB data transition.
- Legacy server retirement only after replacement validation; real mobile acceptance of released web code.
- Catalog collection must run independently before removing its old HTTP-launcher dependency. The existing one-shot `scripts/catalog-supplement-worker.ts` and finite `scripts/complete-logos.ts` can run without an HTTP server; live scheduling/provider completion remains a cutover task.
- Remote GitHub Actions remain allowance-blocked. Local checks do not imply a remote CI pass.
- One symlink test requires a Windows privilege unavailable in this session. Legacy pipeline tests initially failed under incomplete interpreter environments; rerunning under the OCR interpreter with the local reportlab dependency passed19 tests. No dependency was installed into a user's runtime for this check.

Original PDFs, legacy OCR/SQLite, existing personal records and unsent device data have not been initialized, deleted, moved or edited by this milestone.
