# Personal knowledge library MVP implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline. Track evidence in docs/implementation-ledger.md.

**Goal:** Deliver a functioning Korean book/reading/note application with real Neon integration code and a reviewed local preview.
**Architecture:** Next.js server routes authenticate with Neon Auth and query PostgreSQL. Books, reading cycles, notes and revisions are separate owner-scoped records. Test-only PGlite verifies SQL against PostgreSQL semantics.
**Tech Stack:** Next.js 16.4, React 19.3, TypeScript, pg, Neon Auth, Vitest, Playwright.
**Spec:** Original scope and corrections in ../../../../outputs/visuals/free-services-implementation-v3.txt; copy summary below is binding.

## Global constraints
- sources/ remains read-only.
- Carousel stops at both ends; never loops.
- Completion history survives rereading and completion-date edits.
- Korean UI. Paper/PDF on same book may coexist. No invented citations.
- No live data or secrets in Git. Provider unconfigured => explicit unavailable response.
- Demo/preview fixtures must be visibly separate from authenticated data.
- DB mutations record revisions and deduplicate request IDs.

## Review focus
- Invalid calendar dates and leap years: domain tests.
- Same book completed twice vs unique completed books: domain/store tests.
- Cross-user record references: PostgreSQL integration tests.
- Concurrent edits and retry of mutation request: integration tests.
- Touch boundaries, small viewport, changing calendar month: browser tests.

## Tasks
1. Domain and validation — src/lib/domain.ts, tests/domain.test.ts.
   - [x] RED: invalid date, reread, cross-month edits, carousel boundaries.
   - [x] GREEN: validators, reading statistics, calendar cells.
2. Persistent library — db/001_library.sql, src/server/library-store.ts, tests/store.test.ts.
   - [x] RED: owner isolation, add book/note, complete/reread, request dedup, conflict, revisions.
   - [x] GREEN: transaction-based store and migration; tests on PGlite.
3. Authenticated endpoints — src/server/auth.ts, src/app/api/**, tests/access.test.ts.
   - [x] RED: unauthenticated or cross-origin writes rejected; no configuration fails closed.
   - [x] GREEN: Neon SDK routes, pg pool, protected API, login UI.
4. Responsive app — src/components/**, src/app/**, e2e/library.spec.ts.
   - [x] RED: missing bounded carousel, then four review regression cases; supplementary date-edit, touch and mobile assertions.
   - [x] GREEN: dashboard, library, reading calendar, statistics, book/note forms.
5. Verify and handoff — build, typecheck, all tests, fresh review, local preview.
   - [x] Connection-dependent Neon live flows if connection arrives.
   - [x] Record remaining cloud/deployment work without representing it as complete.

Live owner email verification and hosted deployment remain explicitly pending; see docs/implementation-ledger.md.
