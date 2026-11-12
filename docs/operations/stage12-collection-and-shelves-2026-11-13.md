# Stage 12 verification — 2026-11-13

## Windows collection

- Installed phase: 1 (Logos up to 300/day; PDF up to 100/day). Phase 2 is 600/300 and phase 3 is 600/500. The final limits have not been verified or activated.
- Logos triggers: 09:00 and 21:00 KST. Phase 1 disables the evening allowance. PDF trigger: 15:00 KST.
- Each child handles at most 100 resources; PDF retains its 160-provider-request and 20-missing-page OCR budgets. Slots execute children sequentially.
- A shared private lock prevents overlapping scheduled collectors. Daily reservations survive failed/interrupted children. Investigated IDs are excluded before processing and checked again after completion.
- Invalid daily state fails closed. Authentication/quota/DB or startup failures stop the shared controller for operator review. Resource errors stop the current sequence and hold expansion. Midnight stops new investigations.
- Promotion requires successful real sequences at the current phase, and only takes effect for a new daily plan. Today's failed attempts hold expansion. Do not manually set the final phase as an acceptance substitute.
- Current-user interactive Windows tasks require the user to be logged in and the external drive connected. Missed starts use the existing StartWhenAvailable behavior; concurrent launches are ignored. There is no unlimited restart loop.
- Suspend/resume the existing tasks using `Disable-ScheduledTask` / `Enable-ScheduledTask` for `KnowledgeLibrary-Logos-Bounded` or `KnowledgeLibrary-PDF-Bounded`. Enabling a task does not clear a failure hold or daily reservations. Diagnose a hold before resuming; preserve its evidence and checkpoints.

Actual bounded PDF acceptance: 100 investigated; 12 metadata/cover applications; 87 insufficient/no candidates; one unavailable source; zero processing errors; 20 selective OCR pages; 40 Information Naru + 40 Yes24 requests. The first startup failure was a missing installed cached-candidate module; only that module was supplied before retrying.

Two Logos scheduled children failed without an actionable old error code. A subsequent single-resource run succeeded. A 99-resource diagnostic wrote 94 checkpoints (93 completed), but its diagnostic harness timed out after five minutes before final statistics. This is **not** a clean 99-resource acceptance pass. Later offline preflight completed with zero provider requests. All diagnostic capacity was retained in today's reservations, preventing further investigations today. New sanitized failure diagnostics retain error type/status/code and summary counts without request URLs or credentials. Clean later daily sequences are still required before expansion.

No PDF originals or existing search/OCR index records were reset. Existing per-book checkpoint/cache/quota state and generic collector pause configuration were retained.

## Bookshelves

- Shared dropdown for detail/editor: live local shelf search, creation, user-shelf deletion with confirmation, filtered select-all, multiple selection, virtual unclassified state, and one completion save.
- Search edits select creation intent; selecting a row or select-all switches to completion intent even with a partial search remaining. Hidden selections survive filtering.
- Membership save uses the existing edit/version/sync transaction. Deleting a user shelf changes only that membership on affected books, with revisions and replay protection. Built-in shelves are protected.
- Production deployment: `4de58450a5e57cba11c91b89b953ca6181c0f06b`, READY. Actual desktop multi-selection/save/reload passed; the original membership was restored and checked read-only in the production DB. Responsive mobile display and partial-search completion were verified in production.
- Real-device cross-device synchronization was not run. Production shelf creation/deletion was not exercised on user shelves; isolated browser/server tests cover these paths.

## Focused checks

- Shelf-related server/unit tests: 23 passed (four files).
- Shelf browser fixtures: 8 passed, including failure drafts, filtered completion and editor version reconciliation.
- Logos completion plus daily-exclusion tests: 11 passed.
- Sequential capacity tests: 3 passed.
- TypeScript: passed. Vercel production build: READY at the UI commit.
- A broad browser-suite attempt was stopped without a result; it is not counted. Two unrelated calendar fixture timeouts are outside this change and were not presented as a passing full E2E suite.
- Final source review found and resolved pre-side-effect daily deduplication; no other important findings remained in the scoped review.

Machine-specific ledgers, task XML backups, recovery notes, collector scripts, and screenshots are stored in the private operations folder, never in the repository.
