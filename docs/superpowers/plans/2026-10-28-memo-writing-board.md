# Memo search and writing board implementation plan

> **For agentic workers:** Use executing-plans; independent sync and scoped-board tasks may use dispatching-parallel-agents. Shared-file ownership is explicit.

**Goal:** Implement checkbox memo search, complete AI scope selection, usable topic connections, reliable conflict resolution and persistent writing whiteboards with ordered exports.

**Architecture:** Reuse existing material-query, facet, whiteboard and research infrastructure. Add optional board IDs/chapter metadata; retain owner locking, optimistic operations, existing sync entities and legacy assets.

**Tech Stack:** Next16/React19/TypeScript, existing Postgres/PGlite/IndexedDB and Playwright.

**Spec:** docs/superpowers/specs/2026-10-28-memo-writing-board-design.md

## Global constraints

- Draft filter changes do not change results or AI scope until Search.
- Keep raw note text, real links, prior conflicts, legacy writing assets and independent board layouts.
- All sources means all matching records, with explicit count/context/cost feedback rather than silent truncation.
- New schema uses existing sync entity; no forced full-library download.
- Never apply a real user content conflict choice without authorization.
- Preserve running OCR and hidden catalog collection during release.

## Review focus

- Different facets compose correctly online/offline and preserve comma-containing tags.
- AI source indices and payload constraints work beyond24/200 records.
- Membership natural keys and entire note chains survive a reviewed conflict.
- Switching projects cannot save one project's layout into another.
- Chapter/group membership and export order remain stable after memo edits, group graph edits and reload.

### Task 1: Search and AI scope

- [x] Add failing multi-facet and complete-source tests.
- [x] Implement common JSON-array query fields, online/local parity and left checkboxes.
- [x] Separate draft/applied filters and replace inner New Record with Search.
- [x] Add AI all count, fetch complete matching pages, retain context/cost verification.

### Task 2: Topic connections

- [x] Test topic master/detail and disconnection.
- [x] Implement compact topic list, detail selection, reveal and reversible unlink controls in both surfaces.

### Task 3: Sync confirmations

- [x] Reproduce natural-key, research-precondition, nested classification and note-chain failures.
- [x] Implement full intent replay and current precondition resolution, preserving archived requests.
- [x] Verify repeat sync does not recreate resolved confirmations.

### Task 4: Scoped boards

- [x] Test migration, default board compatibility and owned project boards online/offline/backup.
- [x] Implement optional board IDs across persistence and local operations.
- [x] Verify migration on a temporary DB branch before production.

### Task 5: Writing whiteboard

- [x] Test stable chapters/material refs, numeric export and layout restoration.
- [x] Add top-level writing tab and remove old nested workbench UI while keeping old assets accessible.
- [x] Reuse panel/canvas with chapter boxes, add/move materials, order controls, export and project list.
- [x] Verify desktop/mobile, fullscreen, project switching and offline recovery.

### Task 6: Release

- [x] Run focused and appropriate broad checks, typecheck, build, artifact privacy verification and independent review.
- [ ] Deploy migration/code to public and private servers; preserve workers.
- [ ] Verify real app behavior, keep user choices intact, and report outcomes/remaining manual checks.
