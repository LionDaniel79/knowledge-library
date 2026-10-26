# Search word matching

**Goal:** Find 자료 containing every entered word even when the words are separated or reordered, throughout the library.

**Implementation:** Keep existing whitespace/comma tolerance and meaningful symbols. Share the JavaScript matcher and equivalent parameterized Postgres predicate between online and device queries. Existing PDF full-text search already combines words with AND; verify it without rebuilding OCR or indexes.

**Constraints:** Preserve stored titles, excerpts, owner boundaries, exclusion/trash rules, filters and pagination. No schema changes, data downloads, AI calls or external catalogue requests.

- [x] Reproduce missing nonadjacent words in book, memo, material and integrated server/device queries, plus PDF lists.
- [x] Add shared word matching and apply it to those paths and all in-app search fields: selectors, whiteboard, memo box, writing materials, excluded books and catalogue review.
- [x] Verify missing-word rejection, reversed words, punctuation/spacing, literal symbols, ownership, filters, cursors and unchanged source excerpts.
- [ ] Check relevant unit/browser flows, typecheck, build, review and deploy to web and private PC without interrupting OCR.

Review corrections: blank searches return immediately without normalizing row content; SQL recognizes the Unicode spaces accepted by JavaScript; delayed native tag-popup toggle events cannot erase an entered query.
