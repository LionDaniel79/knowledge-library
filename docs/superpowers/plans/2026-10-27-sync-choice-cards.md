# Intuitive synchronization review

**Goal:** Replace raw JSON comparison with named, readable previews that the user can click to select and explicitly apply.

**Design:** Show Server and This PC as radio cards, with a record/book title, operation, changed fields and type-specific content. A reading conflict shows pages; a memo shows title/content/tags; deletion shows its intended action even if text is identical; a whiteboard shows a small layout and counts. Merge/copy remain optional choices for editable notes. Technical originals and download stay in a collapsed section. Selection does not write anything; Apply reuses existing freshness checks and archival resolution.

- [x] Add presentation tests for reading, notes, deletion, catalogue/relationships and bounded whiteboard previews, without raw import data in the main UI.
- [x] Load only needed local titles for review; provide concise operation/title summaries for the list.
- [x] Implement selectable cards, explicit Apply, optional merge/copy, hidden originals and responsive layout.
- [x] Test actual queued conflicts: no writes on selection, close/reopen draft retention, chosen resolution, originals retained, stale-review and unavailable-source guards.
- [x] Verify and review the production release. Web and PC deployment evidence is recorded in the release log; leave the user's 13 actual conflicts unresolved until the user chooses.

Review addressed all editable book facts, same-title edition identities and whiteboard structure beyond counts. Unit coverage includes those regressions; browser fixtures use isolated IndexedDB data, never the user's pending edits.

Validation: 14 unit tests, 10 Chromium/WebKit browser cases, TypeScript and a production build passed. The artifact check found no private entries in the deployment trace.
