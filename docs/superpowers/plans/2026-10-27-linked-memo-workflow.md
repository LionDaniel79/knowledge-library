# Linked memo workflow implementation plan

**Goal:** Read connected memo bundles compactly, reveal/edit them on the whiteboard, and control whiteboard visibility from every shared note editor.

**Architecture:** Use accepted real memo edges to derive connected components; both memo-box and whiteboard use the same grouping. A selected connection reveals its component as a manual board group and reuses the existing versioned relation editor. Store optional hidden note IDs in the existing whiteboard JSON, with a small read endpoint and an owner-scoped visibility command that merges only this setting. Existing board documents and offline queues remain compatible; no new table or database migration.

**User requirements:** Catalog-review heading scrolls away; connected memo list contains titles only; connection-management selection reveals a grouped board and editable relation/reason; disconnect popup is compact; existing-note editors everywhere provide Show/Hide.

**Implementation choices:** Hide affects the board only, never notes, search, memo-box, relations or original files. Connected components include transitive accepted links. Selection reveals a focused group with a clear return to the full board. Visibility changes are saved to the device queue first, then synced by the normal runtime. New notes are visible by default.

## Tasks

- [x] Reproduce catalog-review scrolling with actual content and confirm whether an older open app shell is involved; preserve unsaved input during updates.
- [x] Add connected-component groups and safe board grouping/visibility helpers. Verify cycles, disconnected notes, hidden notes, membership moves, preserved unrelated groups and old board data.
- [x] Implement minimal visibility read/write on server and replica. Verify owner isolation, hidden-note reversibility, idempotent delivery, preservation of concurrent layout changes and offline replay.
- [x] Compact memo-box group list; keep complete notes and relation editing in the selected detail.
- [x] Reveal selected connected memo groups on the canvas; reuse relation/reason editor; keep group edits, undo and version guards.
- [x] Add shared editor Show/Hide controls; compact disconnect overlay with usable touch targets. Verify all note-opening routes use this editor.
- [x] Run relevant unit/browser tests, review and build. Never modify real memo content or resolve pending conflicts during tests; keep OCR running.

## Release verification

- Unit tests: 41 passing, including real server replay of the offline visibility queue and mixed layout/visibility conflict resolution.
- Browser tests: 83 passed on the broad run; two checks used the former button markup for a memo title. Both pass after switching the assertion to its heading role. One pre-existing WebKit touch test is skipped. The focused reveal/edit flow also passes on Chromium and WebKit, including no horizontal page overflow.
- Type checking and production build pass. Build artifact trace contains no private files.
- Independent review found three version/visibility/conflict issues; all have regression coverage and passed focused re-review. React checks preserve shared forms, typed controls, scoped owner checks and the lightweight visibility read.
- The live catalog-review dialog uses the shared static header: scrolling moved its heading above the viewport. No second per-dialog workaround was added.
- Release uses the existing Git production workflow and staged private-PC artifact swap, with rollback and OCR-process preservation checks. Activation results are recorded under the ignored operation directory.

## Verification focus

- Hiding and showing never delete note text, relations or board placements.
- An old client saving a board without the new optional setting cannot erase hidden IDs.
- A new visibility operation cannot overwrite another tab's layout or another note's visibility.
- Group reveal does not duplicate notes or create real connections merely by selecting them.
- Failed relation/visibility saves retain input and remain retryable; full content appears only after a group is selected.
- Dialog titles scroll on both mobile and desktop; closed drafts and unsaved edits survive background updates.
