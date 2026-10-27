# Whiteboard connection selection

**Goal:** Add a checkbox before each connected-memo row and Selected/All viewing actions immediately after the connection counts. Row clicks retain individual connection-group viewing; checking rows does not change the board until Selected is pressed. All shows connected memos, not unrelated notes.

**Architecture:** Keep transient checked IDs separate from the applied connection view. Derive valid accepted note groups from selected edges, deduplicate shared endpoints, and reveal/arrange those groups using existing board helpers. Preserve memo hiding, saved filters, unrelated placements and real connections. Keep the existing compact detail editor and return-to-whole-board action. The added bulk-restoration request uses a new command on the existing knowledge route; no database schema change.

- [x] Add failing helper/browser coverage for selected/all subsets, shared endpoints, removed/rejected connections, persistent checks and mobile controls.
- [x] Implement selection controls and focused group views without creating real connections or joining unrelated groups.
- [x] Verify compact editing, hide/show viewport stability, existing board actions, typecheck and production build; obtain independent review.
- [x] Prepare release through the established Git/private-PC process, preserving the eight OCR processes and existing user data. Record activation evidence in the ignored operation directory.

**Display choices:** Selected/All explicitly fit their connected groups inside the canvas; row clicks retain the existing readable single-group zoom. Background hiding, saves and checkbox changes do not refit. Hidden memo settings remain authoritative. Header controls have visible borders and 44px touch targets. Native disclosure text remains the expand/collapse target; action buttons do not toggle it.

**Review:** Independent review and a focused follow-up found no Important/Critical issues in graph filtering, selection persistence, grouping/filter preservation, empty focus after edge removal or explicit-only overview fitting. Browser fixtures use synthetic notes and APIs, never real user data.

## Added user requests

- [x] Below connection management, add a closed Hidden memos disclosure with independent checkboxes, a selected-show action, and per-note detail opening. Apply a batch as one owner-validated whiteboard visibility command, one device queue entry and one version change. Preserve notes, layout and camera; failures keep selection.
- [x] Move the entire My records panel into the first Memo box tab, left of Connected memos. Pass through all existing owner/tag/save/new-note callbacks, keep the record filters and pagination, and avoid loading connection data while the records tab is active. Update help and UI tests for the new navigation.

**Added-scope review:** Expanded independent review found no Important/Critical findings in atomic bulk ownership checks, failure selection retention, pending-layout flushing, viewport handling or records-tab wiring. Server/replica tests cover foreign-note rollback, duplicate IDs, one version/queue effect, preserved layout/text and actual replay through the server store.

**Verification:** 39 unit tests pass. The broad Chromium/WebKit run passes 100 checks; a mobile bounds assertion was changed to wait for the fit effect instead of reading the prior frame. The eight final focused checks then pass, including all selection views, bulk/per-note restoration, error retry and moved records navigation. One pre-existing WebKit touch case remains skipped. Type checking and production/private-artifact verification pass. Mobile screenshots of the connection actions, hidden list and records tab were inspected.
