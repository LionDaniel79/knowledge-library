# Compact whiteboard details and stable visibility

**Goal:** Selected connections show compact memo titles; clicking a title reveals its body. Hiding a memo preserves the other placements, camera, zoom and page scroll.

**Design:** Keep the memo box's existing full details. Give the shared group renderer a compact whiteboard variant with initially closed memo/relationship disclosures and reduced spacing. Keep relationship editing and drafts mounted. Trace hiding through the real shared editor, board refresh, default placements and native dialog focus before choosing the fix. No schema or sync protocol changes.

**Execution:** Implement directly, as already requested, using the existing React/CSS architecture.

- [x] Add failing browser checks for compact disclosures and hiding through the shared editor while panned/zoomed/scrolled, including initially unsaved placements.
- [x] Fix the demonstrated source of layout/camera/scroll changes; preserve real remote-layout conflict handling and existing filter edits.
- [x] Add compact details only to the whiteboard. Check narrow screens, long titles and relation editing.
- [x] Run targeted tests, independent review and build; prepare release through the existing Git/private-PC workflow. Preserve OCR processes and never test by changing real user notes.

**Findings:** Visibility-only resource updates replaced locally materialized legacy positions, shifting remaining loose notes from 272px to 30px. Preserve the current board and pending placements when the published canonical layout is unchanged; apply only hidden IDs and the new version. Keep camera/filter inputs untouched. Both acknowledged-save paths advance the published layout baseline, covering visibility updates arriving before the normal save echo. Resolution tokens, genuine remote layout changes and unresolved conflicts retain their existing handling.

**Review:** Independent review found the missing save-acknowledgement baseline update. Its regression failed on both browsers before the fix and passed afterward; focused re-review found no remaining Important/Critical issue. Native disclosures retain mounted relationship forms and drafts when closed. No schema/API change.

**Verification:** 32 related unit tests pass; five tests for the merged reading integration pass separately. Chromium/WebKit browser suite: 93 passed, one pre-existing WebKit touch case skipped. Four final shared-editor hide/show checks pass with legacy and saved positions, zoom/pan, background scroll during the edit and scroll after closing. Type checking, build and private-file artifact checks pass. Compact layout screenshots were inspected. Release activation results are recorded in the ignored operation directory.
