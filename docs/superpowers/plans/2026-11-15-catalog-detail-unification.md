# Catalog review and book detail unification

> Execute the user-approved specification from this chat. Use existing APIs, transactions, device synchronization and version guards. No collector changes, no bulk data rewrite.

Goal: unified field-selectable catalog review, compact nonduplicated book information, simpler dashboard/detail UI.
Architecture: extend existing paged review and candidate endpoints; preserve source history and display one consolidated value with alternative conflicting values selectable; keep manual values protected. No new tables.
Tech stack: current Next.js/React/TypeScript/PostgreSQL/device replica.
Spec: user-approved five-section specification in this chat (2026-11-15).

- [x] Candidate review: PDF/Logos/ebook/paper and residual-only other tabs, equivalent comparison and per-field apply including description/toc; batch apply/reject with partial failure retention; existing Logos candidate compatibility and rejection protections.
- [x] Consolidated information: merge curation into automatic information area, deduplicate identical fields across providers, preserve conflicting alternatives and history, hide decided automatic review/undo controls, compact values and sources.
- [x] Detail/dashboard: requested labels, reorder actions/shelves/introduction/information/sources, remove PDF location and relation explanations, compact paginated cycles and collapsed note titles.
- [x] Tests: targeted server/device/unit and representative mocked browser cases; typecheck and one final build. Review failure/owner/version/manual protection.
- [ ] Commit and push existing branch, production deploy, verify READY/exact SHA and read-only live screens. Never modify operational checkout or restart collectors.

Review focus: lost-response retries; mixed-format and residual books; title-only ISBN-less Logos candidates; user edits after auto-apply; provider conflict dedup vs information loss.
