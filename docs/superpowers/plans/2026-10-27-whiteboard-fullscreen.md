# Whiteboard fullscreen and wheel zoom

The user specified the controls and behavior completely; implement directly in the existing canvas.

- [x] Add browser tests for fullscreen entry/return/Escape, unsupported or rejected native fullscreen, editor access, and cursor-anchored ordinary-wheel zoom.
- [x] Add `전체화면` after `정렬`; change it to `이전화면` while active. Prefer the browser Fullscreen API so the board fills the monitor; use a viewport fallback where unavailable. Preserve camera, placements and page scroll. Leave fullscreen before opening details outside the canvas.
- [x] Change ordinary wheel from vertical pan to anchored zoom, keeping the existing 10–180% limits and buttons. Keep drag pan and Shift-wheel/horizontal pan; prevent page scrolling only over the canvas.
- [x] Run relevant browser regressions, typecheck, unit suite, production build and artifact check. Review the diff and prepare public/private release with rollback and OCR-preservation checks.

No database or synchronization changes. Native fullscreen availability depends on the browser; viewport fallback cannot hide operating-system/browser chrome.

Verification: browser regressions 109 passed / 1 pre-existing skip; desktop Chrome and mobile WebKit feature checks 8 passed. Unit suite 610 passed / 4 skipped across 177 files. Typecheck and production build passed; 18,123 traced artifact entries contain zero private entries. Screenshots inspected at 390px and 1280px. Release activation/build identities are recorded in the ignored operation evidence directory.
