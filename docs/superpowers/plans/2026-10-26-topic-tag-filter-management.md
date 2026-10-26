# Topic and tag filter management

**Goal:** In memo search and Knowledge → My records, search/select topics, create a missing topic next to the search input, and delete topics/tags through a minus button and modal confirmation.

Keep existing versioned topic archival and tag-removal APIs, whole-device replica writes, owner checks, record contents and pending drafts. No schema change or AI calls. Use the existing touch-stable FacetPicker popup for topic selection; add optional management controls without changing whiteboard pickers.

- [x] Extend lightweight online/device topic choices with `version`; verify identical results and safe versioned deletion.
- [x] Add shared TopicFilter with immediate text filtering, missing-name creation, optimistic option overlay, minus actions and confirmation. Use existing `upsertTopic`/`deleteTopic` commands and preserve CAS.
- [x] Integrate in AdvancedSearch and TopicBrowser; reset removed submitted filters and refresh choices/results without resetting other input.
- [x] Make TopicBrowser tags searchable and replace tag inline confirmation with the common Modal; preserve tag fingerprint protection and note contents.
- [x] Reproduce missing controls before implementation; run Chromium/WebKit cases for both screens, no-match/duplicate creation, cancel/confirm, rejected deletion, main-form submit prevention and small-screen fit.
- [x] Typecheck, focused DB/replica tests, code review and production build. Public/private rollout is recorded separately; preserve ongoing OCR.
