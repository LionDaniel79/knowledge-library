# Implementation ledger

- User explicitly authorized coding after reviewing the v3 design. No repeated plan approval required.
- Ruling: start the usable library/reading/notes slice first; PDF ingestion, AI linking, Drive, Zotero and MCP remain later milestones as agreed.
- Ruling: new isolated knowledge-library Git repository on feat/library-mvp; no existing repository/worktree to reuse.
- Ruling: retain the approved GitHub/Vercel/Neon stack, rather than switching hosting to Sites.
- Initial legacy Neon connection check returned USER_NOT_LOGGED_IN. User confirmed connection; direct Neon connector authenticated successfully. Legacy connector subsequently also worked. Production never falls back to fixtures.
- Skills: writing-plans, executing-plans, test-driven-development, Neon/Neon Auth/Neon Postgres.
- Follow-up skills: systematic-debugging, react-best-practices, verification, verification-before-completion, requesting-code-review, receiving-code-review.

## 2026-10-10 implementation evidence

- Created free project square-dawn-24347313, library database, isolated branch br-twilight-bird-b3gxmc2o (feat-library-mvp), AWS Singapore.
- Managed Neon Auth enabled. Server verifies the signed-in user, verified email and configured owner allowlist. Credentials exist only in ignored .env.local.
- Migration initially failed because the newly created role could not create objects in public. Resolved by using the existing database owner for migrations; app role library_migrator has SELECT/INSERT/UPDATE on mutable library tables, SELECT/INSERT on revisions, and no schema CREATE. Role name retained, privileges documented.
- Ruling: suspend timeout override was denied by the free plan; provision endpoint with provider defaults. No paid upgrade or plan changes.
- RED/GREEN: first 11 domain/store assertions failed against stubs, then passed. Three access assertions failed, then passed. Export-history assertion failed before implementation, then passed. Unit/PostgreSQL total: 15.
- Implemented owner-scoped transactions, optimistic versions, idempotent request IDs, append-only revisions; snapshot/export use repeatable-read transactions.
- Implemented responsive Korean UI, bounded reading cards, reading cycles/calendar/stats, book addition, editable notes and highlights, search, readable revision history, full JSON export.
- New user request: manually add owned books, and do not assume iReadItNow HD can export. Book addition included. Migration investigation documents verified official facts and uncertain extraction routes; no device data obtained or copied.
- Ruling: add full JSON export now, including history, to prevent data lock-in. Import/restore needs a later tested implementation.
- Browser RED: absent carousel failed initial test. Four initial UI/API tests passed after implementation.
- Fresh reviewer mvp_review identified four important issues: conflict reconciliation, editing during pending saves, mobile logout, carousel state on navigation. Verified all four; added failing regressions, then fixed them in one pass.
- Conflict UI preserves draft, shows current saved record and requires explicit reconciliation before resubmitting with the new version. Saving disables editable fields. Mobile logout remains visible. Card selection lives in app state and clamps on refresh when records leave reading state.
- Browser test harness uses HTTPS to provide secure-context crypto APIs; harness has no Next.js route and cannot bypass deployed auth. These tests mock HTTP responses for reproducible delay/conflict cases.
- Chromium tests: 11 passed, including real touch gestures, mouse drag, mobile width, calendar/date move, book form, preview isolation and logged-out API rejection.
- Actual Neon rollback smoke passed: least-privilege role, add book, retry idempotency, complete/edit/re-read, note revision history, owner isolation. Test records were rolled back and absence verified.
- TypeScript and production build passed. npm audit reports 0 vulnerabilities. Auth SDK beta peer warnings remain upstream; no forced dependency overrides.
- Desktop/mobile preview and login screenshots reviewed; browser pageerror capture empty.
- Ruling: retain the new local feature branch. No pre-existing base branch, GitHub repository or Vercel deployment has been selected/provisioned, so no merge/push menu applies to this initial coding milestone.

## Explicit limits and next handoff

- Owner's actual account signup, email delivery/verification, session refresh and full authenticated browser-to-Neon round trip need human email verification; not represented as completed.
- GitHub remote and Vercel deployment are not created. CI configuration is ready, but the hosted CI run is unverified.
- No iReadItNow HD file/backup available; no extraction or import performed.
- No PDF/OCR/Zotero/Drive/MCP/AI processing yet. Current search is lexical.
- Catalog metadata editing, ISBN checksum/provider validation, password reset, JSON restore, offline queue, server pagination are future work.
- Sources under the project mirror remain untouched.

## 2026-10-13 import and Google login

- Supersedes the earlier account/import limits: user supplied recovered iReadItNow HD data and authorized use of all 1,685 owned records. Original SQLite was read only; account database and credentials were excluded.
- Converted and imported 1,685 books, 27 notes and 130 nonempty reviews into the verified owner's Neon account. Formats: paper 474, ebook 633, unknown 578. Preserved 428 original sessions and 1,570 bookmarks plus original tables and database hash.
- Ruling: unconfirmed status codes remain original records, excluded from completion statistics; missing format remains unknown. No guessed completions or PDF classifications.
- Local PGlite applied the full real package twice: second import added zero. Live preview after import also reports 0 new books/notes, 1,685/157 existing records. Original edits are never overwritten by reimport.
- Surface: imported-book provenance, legacy reading records, ebook filter, import preview/retry, owner-authenticated hash-checked local cover endpoint. Assets stay on the PC; remote hosting needs private asset storage.
- Google OAuth initiation succeeded but the user reported returning to the start screen. Root cause: Neon middleware skips loginUrl before OAuth verifier exchange, while loginUrl and callback were both '/'. Separated '/auth/sign-in' and '/'. Two regression tests failed with 200 instead of the required redirect, then passed using the actual installed SDK with fake upstream responses.
- Fresh verification: 20 Vitest tests, 14 Chromium tests, TypeScript production compilation, Next production build passed. Earlier Python converter 3 tests and actual Neon rollback verification passed. No application-auth bypass introduced.
- User confirmed the actual Google flow opens the library; inspected the authenticated browser showing 1,685 books/157 records and reloaded it successfully with the session retained.
- Fresh read-only review by import_auth_review found no additional ownership/idempotency/auth defect; found photo-note attachments are retained but not displayed. Ruling: defer as Minor for this data migration because all 27 actual note snapshots are null and no requested record loses visible content. Before supporting other backups with photo notes, add authenticated note-image display and browser coverage. Converter/endpoint support alone is not a complete photo-note UI.
- Remaining: original reading-status mapping, full JSON restore, cloud image storage, GitHub/Vercel deployment and the prior PDF/AI/Zotero milestones. Sources remain unchanged.


## 2026-10-13 knowledge-library expansion

- User scope confirmed: only E:\전자도서관; completed415/current4; app-reported2026 amount25.5. Actual source sessions ended2026=27. Ruling: preserve distinct measures instead of altering dates.
- Removed decorative cover frame and imported-note caption. Increased body/card text and contrast. Desktop and mobile browser checks; small-screen navigation scrolls instead of compressing seven labels.
- Applied migrations003–005. Imported419 deterministic reading cycles. Imported9309 PDF file records in250-record transactions after one long transaction was reset/rolled back. Live catalog10994 books; original157 notes untouched.
- Local PDFium/SQLite page index supports resumable work, inventory, original-change invalidation, metadata/TOC, exact extracted text. Current worker is still processing; OCR/errors remain explicit. No original files written, copied or uploaded.
- Added authenticated PDF list/search/detail/file/raster-page APIs, range handling, source lookup, pinned source links, exact quote verification and immutable PDF highlights. User titles may change; interpretations belong in separate notes.
- Added explained shared-term suggestions, relation decisions, optimistic revisions, rejection preservation, automatic suggestion attempt after note save, source snapshots in sermon/thesis collections, Markdown export. Full JSON export is v3 and includes new records.
- Ruling: use the existing local feature checkout and continue authorized code/data implementation. No repeated permission request, no publish/push. Sources mirror untouched. No claim of semantic AI, OCR, Zotero or completed full-file hash coverage.
- Ruling: IAB native PDF rendering was blank. Added bounded local raster viewer using existing PDFium dependency; actual PDF74 page visibly displayed with original content. Normal file-open link retained.
- Fresh review found three Important issues: stale citation links, editable verified quote attribution, offline missing-file search exclusion. All fixed with failing-then-passing tests. New viewer received targeted follow-up review.
- Verification: TypeScript pass; Vitest34, Python5, Playwright17 pass; Next production build pass; actual Neon rollback smoke pass. Live browser confirms415/4/27/25.5, original cover without frame, quote search+page viewer, and3 suggestions from 정서와 작업하기. Source snippets are exact extraction, not generated prose.
- Remaining limits: lexical suggestions; local index still processing; OCR not implemented; metadata starts as unverified filename; no full collection hash/dedup or Zotero/Drive/MCP/deployment. Browser catalog initial load fetches all records.

- Final live reimport: completed415/reading4/added0; PDF files9309/addedBooks0. Direct full-library snapshot stalled on cloud ClientWrite during the reading-only recheck; stopped only that task-owned process, narrowed legacy query to required iRead fields, then recheck finished in2.6s. Focused7 tests and TypeScript passed after this query change. Formatting and diff checks passed.
- Reviewer follow-up: no new Important/Critical issues, all3 original findings confirmed fixed. Reader implementation and best-effort automatic note connections reviewed.
- Last local index snapshot2026-10-13 14:29: 281122 pages processed; ready3283/indexing1470/pending2993/needs_ocr1359/partial_ocr119/error85. Worker remains active; these are progress counts, not final totals.
- Kept local feature branch and uncommitted implementation for continued user iteration. No remote repository, PR, deployment, destructive cleanup or source-file changes performed. Proof screenshot is outside repo in artifacts/library-expanded-stats.jpg.

## 2026-10-13 catalog, bookshelves, note discovery and thought-map design

- Implemented the requested left navigation drawer with keyboard dismissal/focus return; larger calendar covers retain existing cell heights. Renamed the completed-book filter to 완독. Added metadata editing, registration/title/author sorting, subject and bookshelf filters, multiple bookshelf assignment and bookshelf creation. Default shelves: 책 대기열, 내 인생 최고의 책들.
- Applied migration006 to the owner's live database. Book metadata edits, bookshelf changes and note tags retain optimistic concurrency, idempotency and append-only revisions. Export schemaVersion4 includes the new fields and shelves.
- Added editable tags plus note text/tag/kind/book/date filters. Tagged157 existing notes without altering their original dates. Source-verified PDF quote content/page attribution remains immutable.
- Ruling: use KDC broad categories but distinguish suggestions from library-verified codes. Assigned10389 suggestions among10994 records; official verification0 because no Data4Library key exists. User asked for issuance guidance; docs/catalog-enrichment.md gives the official signup/application link and private configuration instructions. Query adapter/fixture validation are implemented, real-provider verification remains pending the key.
- Enrichment preserves existing user fields and exact edition matching. Linked5 covers from matching existing editions and24 external covers;31 Open Library ISBN/title matches supplied bibliographic data. Read-only live audit confirmed no stored-ISBN/provider-ISBN mismatches. Local PDF page counts and2327 explicit article filenames were structured. ISBN extraction alone never certifies a book match.
- Created9219 private PDF first-page previews from9220 eligible files;1 failed. The remaining89 catalog PDFs were excluded by processing status. First-page previews are identified separately from verified cover images. Original PDFs were not changed or uploaded.
- Fresh reviewer catalog_review identified4 important issues: rerun overwrites of explicit user choices, lost bookshelf conflict drafts, mismatched candidate ISBNs, stale verified classification after ISBN/title edits. All addressed; corresponding unit/UI regressions pass. User-edited records are protected from later automatic enrichment.
- Final validation: Vitest40, Playwright21, Python5 passed; TypeScript/Next production build passed; actual Neon rollback verification passed. Authenticated browser confirmed filters, covers and editing controls. Screenshot: ../artifacts/library-catalog-updated.jpg. Formatting and whitespace checks completed after formatting existing test files.
- Last PDF text-index snapshot:514139 pages; ready3501/indexing3240/pending689/needs_ocr1603/partial_ocr186/error90. Original worker PID8860 remains active; this is not an OCR/AI completion claim. Thumbnail worker completed separately.
- Thought-map decisions confirmed by user: prioritize evolution of their own views, chronological evidence, distinguish book claims from personal stance, require explicit approval of changes, run AI on the PC and sync results. Hardware observed: Ryzen5 5600G, approximately16GB RAM, integrated Radeon; no NVIDIA/Ollama command found. No model installed or benchmark performed.
- Wrote docs/superpowers/specs/2026-10-13-thought-evolution-design.md for written-spec review under Superpowers brainstorming. Model candidates and limitations are documented from official sources. Local AI worker, remote device queue, semantic search and generated evolution candidates remain unimplemented; current suggestions are lexical.
- Retained the existing local feature checkout; no GitHub push, Vercel deployment or changes to synced sources. Only the new design document is committed separately for review; other ongoing implementation changes remain available locally.
