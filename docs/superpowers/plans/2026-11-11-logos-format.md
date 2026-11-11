# Independent Logos format implementation plan

> Execute inline with superpowers:executing-plans. The user's exact requirements and prior instruction to make routine decisions autonomously govern this bounded change.

**Goal:** Separate imported Logos ownership from generic ebook ownership without replacing books or their records.
**Architecture:** One ordered format definition across domain/UI/search/cache, source-proven normalization in new migration041, normal sync capture/version increments, and unchanged backup identities. No title/tag inference.
**Spec:** User's eight requirements and five validation requirements in the November11 request.

## Rules / decisions
- Format order: paper,logos,ebook,pdf,unknown; labels 종이책,로고스,전자책,PDF,형식 확인 필요.
- Confirm provenance with owner-matched library_book_sources.source_kind=Logos or source_data.app=Logos. No title/tag/shelf matching.
- For a proven Logos book lacking logos, replace its legacy ebook marker with logos and preserve paper/pdf/unknown. Add logos if no ebook marker exists. If logos is already present, retain an explicit additional ebook format.
- Migration only changes formats and increments the changed book's version once. Existing IDs, metadata, notes, cycles, shelves, covers and revisions stay intact. Existing sync triggers publish incremental changes; reruns emit no new changes.
- Future source inserts/legacy backup restores normalize the same way. New Logos imports write logos directly.
- Older migration002 must not reinstall its bootstrap format constraint over existing modern data on a full runner replay; skip its completed bootstrap when its import schema already exists. Do not edit historical migration SQL.

## Tasks
- [x] A. RED: source-only/source_data/multi-format/false-positive/idempotency/personal-history/sync cases in isolated PGlite; domain/cache/filter/backup/import cases.
- [x] B. Implement041, ordered domain format, import, UI/filter/stat/cache paths and runner replay guard. Run changed-path tests to GREEN.
- [x] C. Browser4 passed; unit866 passed/four conditional skips, typecheck and production build passed. The initial full run exposed a restricted-role provenance lookup failure; the narrow SECURITY DEFINER trigger fix passed19 related regressions and the final full run.
- [x] D. Reviewed final diff and read-only live provenance/count preview. Prepared a transactional encrypted-snapshot/preservation/idempotency operator and completed the non-mutating constraint expansion. Code release precedes actual classification; execution evidence is recorded in the private operations report after deployment.
- [x] E. Implementation results and rollout limitations documented in `docs/operations/logos-format-2026-11-11.md`. No original PDF scan, repeated full restore rehearsal or unrelated feature changes.
