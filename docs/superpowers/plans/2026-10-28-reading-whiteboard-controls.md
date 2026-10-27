# Whiteboard and reading controls

Implement the user's specified controls directly in the existing components.

- [x] Whiteboard: accept `unclassified` alongside topic IDs, match notes with no accepted note/book topic, and add the option to the picker. Add `전체 펼침` / `전체 접음` after the memo count, changing only displayed groups' collapsed state through the existing undo/save queue; retain camera, placements, hidden groups and relationships.
- [x] Calendar: turn the header icon into a date-jump control with a date field, `이동` and `오늘`. Update displayed month and selected date together on the home and calendar screens.
- [x] Statistics: remove the requested footnote. Render the selected month's completed cycles in ascending completion-date/ID order as clickable covers. Keep rereads, pagination and stored covers. Query only that month through the same owner-scoped server and device repository interface; use the full in-memory library in preview/local fixtures.
- [x] Verify with failing-then-passing UI tests, server/device query parity, full unit checks, relevant browser regressions, typecheck, production build and artifact privacy check. Prepare public/private releases and rollback; record activation identities and OCR process preservation in ignored operation evidence.

No database schema migration or paid API call. Dates outside the selected month, undated records and unfinished cycles do not appear in monthly covers.

Verification: 614 unit tests passed / 4 skipped (178 files); browser regressions 103 passed / 1 pre-existing WebKit touch skip. Final feature checks passed 10/10 at desktop 1280px and mobile WebKit 390px, including arbitrary calendar-year navigation into statistics. Typecheck passed. Screenshots inspected. No live notes or DB data were modified for testing. Release activation identities are recorded in ignored operation evidence.
