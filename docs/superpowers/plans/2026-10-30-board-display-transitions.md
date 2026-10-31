# Board display and transition corrections

The user's nine requested corrections extend the existing library. Menu order is memo box, whiteboard, writing bundles. Book removal is reversible and leaves original PDF files and notes intact. Writing numbering stays local; titles and original thought-bundle contents remain shared.

## Display model
- Selecting an existing connected group or thought bundle is a reversible view operation, not a content write. Click/check again to hide that displayed item.
- Ordinary whiteboard's return-to-all action shows individual memos, retaining saved original boxes for later selection. Writing project boxes remain intact when viewing extra connections.
- Disconnected memo stacks are reconciled against accepted connections; obsolete stack frames disappear while their memos and coordinates remain.
- Group selection, reading, viewport changes and unrelated metadata renders must not recompute every scene or save a full board.

## Work
- [x] Reproduce and correct ephemeral selection, stale stack rendering and transition cost; regression and measured comparison.
- [x] Reversible book delete with device/online/owner guards and recovery.
- [x] Desktop numbering, title layout and menu order with integrated CSS browser checks.
- [x] Reproduce merge failure using actual device queue, correct shared-draft handoff without weakening version guards.
- [ ] Integrated tests, review, build and privacy check, web/private PC release with existing OCR/collector processes preserved.

No real user test data, original PDF deletion, paid AI calls or broad process termination are needed.

## Evidence
- Display-only selection makes no content/board write; thought/memo rows and checkboxes toggle without creating originals. Returning to ordinary All shows flat memos. Generated disconnected frames are reconciled against accepted components.
- Explicit edits materialize virtual box references; virtual deletion, drag, order assignment, new box after All, canonical export while hidden, and legacy accepted bundle lines have regression coverage.
- Actual device runtime/outbox tests reproduce and prevent stale-draft requeue on board handoff, including a newer edit, delayed echo, remount, and genuine external conflict.
- PC/mobile integrated CSS tests cover native numeric inputs, six-digit visibility and original title width; Chrome/WebKit screenshots inspected.
- Measured fixtures: 5,000 notes / 10,000 memberships scene median 659.3→25.4ms; 2,000 notes / 4,000 edges line calculation 20.2→2.1ms. These are synthetic performance comparisons, not a guarantee of UI frame rate.
- 034 migration was applied twice on a temporary branch; all 5,208 existing exclusion rows retained. Original PDFs/user records were not used as test mutations.

## Final checks
- Full unit run: 741 passed, 4 skipped. Focused later view/ordering/link regressions also passed.
- Related Chromium suite: 74 passed; final shared view regressions 18 passed; actual device-queue regressions 7 passed. WebKit view/device suite passed; integrated PC/mobile screenshots were inspected.
- Both review passes were resolved, including virtual box removal/drag, adding after plain view, canonical exports while hidden, legacy bundle lines and stable numbering against hidden chapters.
- Final draft restoration checks the already-durable final value before retrying a predecessor. Real divergent external edits still require an explicit choice.
