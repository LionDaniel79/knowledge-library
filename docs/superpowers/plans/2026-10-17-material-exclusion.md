# Reversible material exclusion implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Exclude the approved 5,208 paper/periodical records from normal library browsing, totals and search, with restoration and durable reindex protection.

**Architecture:** Keep the existing book and document rows, file identities and original PDFs. Store exclusion state separately; active-book/document/cycle views provide consistent normal reads. A paginated owner-only exclusion panel restores a record with version and request-id checks. Existing importer conflicts preserve the exclusion table.

**Tech Stack:** Next.js/React, TypeScript, PostgreSQL, Vitest/PGlite, Playwright.

**Spec:** The user's approved design in this conversation (2026-10-17): exclude 5,208; retain original PDFs; defer 37 ambiguous records; allow restore; never reactivate exclusions through reindexing.

## Global Constraints

- No PDF file writes, moves, deletes or original-file backup operations.
- Apply exactly the frozen inventory in `.superpowers/sdd/2026-10-17-bulk-archive/preview.private.json`; validate its versions and current classifications before writing.
- The 37 `material_kind='review'` records remain active.
- Existing notes, reading history, covers, metadata, links and file source keys are preserved.
- Keep runtime role privileges limited: no broad DELETE or auth-table access.
- Reuse the current checkout; leave the unrelated `next-env.d.ts` change untouched.
- Implement sequentially under the user's existing authorization; review the entire change once before deployment.

## Review Focus

- Cross-owner or stale restore requests must fail without changing state.
- Reindex/reimport must not reactivate excluded rows; explicit restoration must persist.
- Search auxiliary/connection/topic routes must not reintroduce an excluded book.
- Backup/export must include exclusions and all retained book rows; older backups remain accepted.
- Mobile restoration, failure retry and out-of-order paginated responses must remain usable.

### Task 1: durable exclusion and restoration

**Files:** `db/025_book_exclusions.sql`, `src/server/book-exclusions.ts`, `tests/book-exclusions.test.ts`, migration/runtime grant files.

**Interfaces:** `createBookExclusionStore(db).exclude(owner,{requestId,items:[{id,expectedVersion,kind}]})`, `.restore(owner,{requestId,id,expectedVersion})`, `.list(owner,{q,limit,offset})`; active views `library_active_books`, `library_active_documents`, `library_active_cycles`.

- [x] Write tests for exclusion preservation, owner/version/idempotent restore, ambiguous-record rejection and importer replay.
- [x] Run tests to see the missing feature fail.
- [x] Add owner-scoped exclusion state, active views and transactional audited operations.
- [x] Verify tests and restricted runtime privileges.

### Task 2: consistent visibility and retained backups

**Files:** catalog/snapshot/search/MCP/knowledge/topic/PDF read paths, `library-backup.ts`, `library-store.ts`, `backup-json.ts`, integration tests.

**Interfaces:** Existing normal reads use active views; export/backup/import still use retained base rows and include exclusion state. Personal notes remain intact.

- [x] Add integration assertions for counts, catalog search, auxiliary search, PDF/topic visibility and backup/restore.
- [x] Observe failing assertions, update only relevant read queries, then verify.
- [x] Keep all import writes on original tables and cover replay in tests.

### Task 3: owner-only restoration screen

**Files:** `src/app/api/book-exclusions/route.ts`, `src/components/book-exclusions.tsx`, `library-app.tsx`, CSS, mobile E2E fixture.

**Interfaces:** GET exclusion page; POST restore with origin/owner checks and stable retry ID. Library toolbar button `제외한 자료`; searchable paginated records with `복원`.

- [x] Add a mobile UI test proving recovery, stable retry and refreshing the normal library without editing files.
- [x] Observe RED; implement the panel with existing page-size/device preferences and modal components.
- [x] Verify mobile bounds, stale fetch protection and error feedback.

### Task 4: review, safe migration and exact application

**Files:** operator script for guarded preview/application; private verification ledger.

- [x] Run typecheck, meaningful unit/E2E checks and webpack production build; verify artifact contains no private files.
- [x] Obtain one independent whole-change review; address material findings.
- [x] Test migration and the frozen 5,208 selection on an expiring copy of the existing production branch.
- [x] Apply schema and exact guarded batch to the existing owner only; verify 37 deferred records, notes, cycles and originals are unchanged.
- [ ] Commit/push and deploy the public app and a new immutable private-PC release; verify counts and recovery UI without restoring the user's real records during tests.
