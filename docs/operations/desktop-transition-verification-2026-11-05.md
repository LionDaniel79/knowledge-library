# Desktop-library transition verification — 2026-11-05

Implementation branch: `feat/desktop-library-completion`, base `c09137bfad05e63fa72223bf489fdd9af9bfdfee`.

## PASS
- Web unit: 845 passed; four existing environment-dependent tests not run.
- Browser: 304 passed. Retired PDF original/OCR UI tests were removed; replacement native and web-retirement tests run without new skips.
- Windows: 70 Python tests passed. WPF legacy-overlay and first-user/no-index search, page rendering, cancellation, queue, folder watcher, tray, explicit Exit, setup and DPAPI smoke passed.
- Production web build, TypeScript, formatting, and patch whitespace checks passed.
- Optional backup tables round-trip resource identity, deletion blocks, completed-scan evidence, source provenance and cover locations without auth secrets.
- Fresh AES-256-GCM archives restored to independent encrypted PostgreSQL18: QA65 tables and production59 tables. All table content/schema fingerprints and tested relations match. Private artifacts remain outside Git.
- QA migrations036–039 applied after verified backup. No existing book/note/PDF/OCR data changed.

## Implemented
- Native whole-library inventory, content identity, read-only legacy OCR reuse, new private OCR/FTS queue, pause/retry/resume and incremental HTTPS bibliography/location updates.
- Per-item unresolved identity quarantine, bounded same-identity version recovery, immutable retries and actual completed-scan snapshots. Disconnection never authorizes deletion.
- New web registration/scan APIs; manual edits and purge tombstones protected. PDFs, OCR text, hashes and local absolute paths never uploaded.
- Web original-search/OCR/PC UI removed; legacy endpoints return410. Bibliography, page references and safe relative storage locations retained.
- Logos source import and durable finite enrichment, protected digital-edition matching and managed-image storage. Bad cover images cannot starve subsequent work.
- Guarded web-only purge requires exact reviewed target versions, current complete manifest, verified backup evidence, and dedicated enablement. Personal references hold a record from deletion.

## Read-only inventory / preview
- Whole storage9319 physical PDFs; selected roots4109 (Christian3598, General511).
- Existing legacy index9321 documents; all9321 have SHA-256. Old path absence includes moved excluded material and is not a missing-file conclusion.
- Logos source2620; eligible2418, excluded202; permanent2246, temporary172.
- Production Logos preview:2412 new candidates, six potential existing editions held; applied=false.

## NOT_RUN / remaining
- Preview deployment/new HTTPS client acceptance, actual native installation and full identity scan.
- Production schema/release, real PDF/Logos registration and live provider coverage.
- Exact live web-only purge preview/final destructive approval and execution.
- Legacy server retirement only after replacement validation; real mobile acceptance of released web code.
- Remote GitHub Actions remain allowance-blocked. Local checks do not imply a remote CI pass.

Original PDFs, legacy OCR/SQLite, existing personal records and unsent device data have not been initialized, deleted, moved or edited by this milestone.