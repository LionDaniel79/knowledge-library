# Application cleanup and optimization implementation plan

> **For agentic workers:** Use superpowers:executing-plans for direct implementation. Steps use checkbox syntax for tracking.

**Goal:** Remove verified unused code and reduce startup, device-query, sync and server work without changing active user workflows or stored data.

**Architecture:** Keep the existing Next.js/React app, whole-library device replica, Postgres synchronization, and private PDF/OCR server. Use import-graph evidence plus endpoint/worker/test references for cleanup; optimize work at existing boundaries instead of introducing a new storage architecture.

**Tech Stack:** Next.js 16.4.2, React 19.3, TypeScript, IndexedDB, PostgreSQL/pg, Vitest/PGlite, Playwright.

**Spec:** User request on 2026-10-26: thoroughly analyze the whole program, remove deleted-feature/unused code and optimize it. Existing approved local-first/offline and direct sequential implementation requirements remain authoritative.

## Global constraints

- Preserve user data, original PDFs, OCR candidates, revisions, exclusions, offline outbox and existing credentials. No schema/table/data deletion or real test records.
- Do not interrupt the eight ongoing OCR processes. Keep hidden PC server operation and authenticated owner isolation.
- Keep externally reachable MCP/auth/PDF APIs and old-device command compatibility. A missing import alone does not prove an endpoint or maintenance utility is obsolete.
- Do not install dependencies or invoke AI/API enrichment. Keep server and browser boundaries and all lazy assets available to offline shell installation.

## Review focus

- Archived/rejected/inherited topics must keep identical filtering semantics; exercise query parity fixtures.
- Unchanged cross-tab sync must avoid data reloads while real edits, outbox effects and clear-download remain visible; exercise runtime revision and settings tests.
- Removed UI must not remove shared tag/trash/search code or existing pending command handlers; verify reachability and active navigation.
- Idle DB disconnects must not crash the server or expose connection secrets; test synthetic pool errors.
- Conditional cover responses must authenticate ownership before 304 and avoid returning image bytes from DB on unchanged requests; test store and route with isolated fixtures.

## Tasks

### 1. Verified cleanup and cold-load boundaries

- [x] Inventory imports, Next routes, worker URLs, scripts, dependencies and baseline test results. Review all unreachable candidates manually.
- [x] Remove obsolete LibraryApp notes-view branches and dead imports/helpers; retain navigation of old notes links to knowledge.
- [x] Delete unreachable removed-feature UI/local-analysis modules and their obsolete-only tests. Retain test fixtures, maintenance retention, API tombstones and shared search/ranking/evaluation code where referenced.
- [x] Lazy-load conditional feature/modal panels using existing React lazy/Suspense patterns. Preserve editor identity and offline asset manifest.
- [x] Verify TypeScript unused-symbol checks, navigation/search and replica shell tests; record build entry/chunk evidence.

### 2. Device reads and notifications

- [x] Add operation-count regressions for catalog/search table dependencies, linear book/topic/status filtering and unchanged cross-tab notification behavior; observe failures.
- [x] Separate catalog/search dependency stamps and skip search-only tables during catalog build in `src/client/replica/repository-local.ts`.
- [x] Build topic membership/status lookups once per query in `src/client/replica/queries.ts`, preserving rejection/inheritance rules.
- [x] Compare consistent checkpoint data tokens before cross-tab invalidation in `src/client/replica/runtime.ts`; refresh status even without data changes.
- [x] Run query parity/startup/runtime/outbox/offline settings tests and record operation counts instead of unstable timing thresholds.

### 3. Server work, bandwidth and resilience

- [x] Add failing pool-idle-error regression in `tests/mcp-read-pool.test.ts`; add sanitized listener to `src/server/mcp-http.ts`.
- [x] Add reorder query-count regression; project only item identity and batch placement reads in `src/server/knowledge-store.ts`, retaining atomic CAS/revisions.
- [x] Add heartbeat-threshold and immediate revoke tests; throttle replicated last_seen writes in `src/server/thought-device-auth.ts` without weakening authentication.
- [x] Add authenticated cover revalidation tests and conditional byte-free reads using stored SHA-256 in cover store/route.
- [x] Pre-group PDF documents for bulk exclusions in `src/server/book-exclusions.ts`, preserving atomic review and exclusions.

### 4. Integration and rollout

- [x] Run the complete unit/integration suite, relevant Chromium/WebKit flows, typecheck, formatting and production build/artifact checks.
- [x] Independent read-only code review; fix material findings before merge.
- [x] Record actual cleanup, before/after work/bundle metrics and retained compatibility in an operations report.
- [ ] Merge/push the verified change, confirm Vercel READY, update private PC artifacts with rollback and check OCR process preservation.
