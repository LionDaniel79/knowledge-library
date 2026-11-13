# Stage 13 — stable sync UI and whiteboard connection details

## Causes and minimal changes

- Header actions used intrinsic button/status widths and wrapping. The busy label and growing transfer explanation changed action geometry. The sync button now reserves 8.5rem; the status slot reserves 9rem and a line height even while empty. It displays one busy label on the disabled button; error/login/offline status remains available. Detailed progress remains in the existing sync settings, not in the heading.
- Book detail was gated by `detailState.revision === data`. A changed overview object temporarily removed the selected book, swapping modal branches; the following effect also replaced complete detail with partial overview data. The same selected book now stays mounted during revalidation; abort guards retain selection safety and real changed data still refreshes.
- Replica cover URLs were keyed by the global data revision. An unrelated data change cleared/revoked an unchanged image while reacquiring it. URLs are now retained for the same runtime/asset identity until replacement is acquired, with cancellation and release on changed identity or unmount.
- Commit `31782f2` added an external connected-memo detail section on 2026-10-27 to reuse relation/reason editing after connection selection. That section is removed from between canvas and connection management. The existing editor is retained inside a closed `선택한 연결 상세·수정` disclosure under connection management. Native disclosure behavior retains unsaved editor drafts. Data, board layout, connections and existing commands are unchanged.

## Verification

- Three header browser fixtures: 1280/390/320px; identical sync/add-book/below-content geometry before, during all busy phases and after completion/error/offline; one busy label; duplicate requests disabled; login/error retained.
- One real in-memory replica/runtime/repository browser regression: manual sync phases cause no query churn; a delayed actual data revision preserves modal DOM, cover DOM/blob URL, scroll and pending shelf selection; changed publisher and changed cover arrive; image URLs are released after unmount. The original implementation failed this test with lost DOM/cover and reset scroll before the fix.
- Seven focused whiteboard browser checks: desktop/mobile disclosure and draft retention, hidden memo/camera preservation, unlink/undo, drag/connect/fold/group interaction and keyboard connection.
- Two existing sync push-progress unit tests passed; TypeScript and diff checks passed. No full-suite rerun, DB migration or external book-information API calls.

Operational screenshots and final deployment observations are stored privately. Browser fixtures do not substitute for physical iPhone/iPad verification. No Windows source installation, collector restart, schedule/quota/cache/checkpoint or user-data changes are part of this UI release.
