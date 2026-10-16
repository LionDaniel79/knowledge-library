# 승인 대기 중 자료 보존·조회 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 외부 서지 API 승인 없이 호출량 보호, 복원 가능한 백업, 대용량 목록 조회를 완성한다.

**Architecture:** 서지 호출 직전 로컬 SQLite에 사용량을 예약한다. 지식 데이터는 명시된 테이블의 일관된 스냅샷으로 백업하고 빈 서재에만 원자적으로 복원한다. 앱은 통계·기록에 필요한 책 요약과 서버에서 검색한 목록 일부를 받으며 상세 정보는 선택 시 읽는다.

**Tech Stack:** TypeScript, Node SQLite, PostgreSQL, Next.js, React, Vitest/PGlite, Playwright.

**Spec:** `docs/next-implementation-roadmap.md`의 1·3·4단계 중 승인 대기 중 가능한 세 가지 작업. 나머지 단계는 이번 범위가 아니다.

## Global Constraints

- 사용자의 원본 파일·독서 기록·메모를 덮어쓰거나 삭제하지 않는다.
- 실제 외부 서지 API 호출·유료 AI 호출·배포·공유 저장소 push를 하지 않는다.
- 논문·간행물은 기본정보만 보관한다. 실행 중인 OCR 작업을 중복 실행하지 않는다.
- 출처는 펼쳐 볼 때 보이며 일반 저장·검색에는 AI 호출이 없다.
- 기존 feature 브랜치에서 직접 순차 구현한다. 승인받은 구현 방향을 다시 묻지 않는다.

## Review Focus

- 동시에 실행한 수집기와 재시작이 공유 한도를 우회하지 않아야 한다.
- 악성·잘린 백업, 다른 소유자 ID, 깨진 참조는 부분 복원을 남기지 않아야 한다.
- 백업의 자동 작업·인증 정보가 복원 후 실행되거나 권한을 얻지 않아야 한다.
- 목록에 아직 불러오지 않은 책도 메모·연결·상세 화면에서 선택할 수 있어야 한다.
- 검색 조건 변경 중 늦게 도착한 응답이 새 결과를 덮어쓰지 않아야 한다.

### Task 1: 영구 서지 호출량 관리

**Files:** `src/local/curation/api-quota.ts`, `src/server/catalog-provider.ts`, `src/local/curation/catalog.ts`, `scripts/collect-catalog.ts`, `.env.example`, `tests/catalog-quota.test.ts`, `docs/catalog-enrichment.md`.

**Interfaces:** `reserveCatalogRequest(provider, key, options?)` reserves one attempt, returns safe usage; throws `CatalogQuotaError` before fetch. Persist in shared local SQLite; no plaintext keys. Default maximum 450 attempts per rolling 24 hours, configurable up to 499 without an explicit registered-IP setting. Both library lookup paths share the reservation. Cache reads consume zero.

- [x] Write tests for restart persistence, window expiry, provider separation, failed requests counting, concurrent reservations and invalid settings.
- [x] Run `npm test -- tests/catalog-quota.test.ts`: expected RED for missing reservation behavior.
- [x] Implement reservation with immediate transaction and safe error/status handling. Network errors never include key or request URL; redirects forbidden. Bound collector network attempts independently of matched book count and persist progress on failure.
- [x] Run quota tests, `npm test`, `npm run typecheck`: expected PASS.
- [x] Commit only this task and its documentation.

### Task 2: 복원 가능한 지식 데이터 백업

**Files:** `src/server/library-backup.ts`, `src/app/api/backup/route.ts`, `src/components/backup-panel.tsx`, `src/components/library-app.tsx`, `tests/library-backup.test.ts`, `tests/backup-routes.test.ts`, `e2e/library-backup.spec.ts`, `docs/backup-restore.md`.

**Interfaces:** `createLibraryBackup(db, owner)` returns a versioned envelope with schema, counts and SHA-256 integrity check. `inspectLibraryBackup(db, owner, input)` validates and reports counts/eligibility. `restoreLibraryBackup(db, owner, input)` uses one transaction, only for a completely empty target, without deleting/merging records. Current knowledge tables, import provenance, revisions, research, thought map and curation are included; authentication, device tokens, operational queues and AI spending policy are excluded. Local PDF originals/index and imported image binaries require separate file backup.

- [x] Test exact round trip of books, cycles, notes, revision/provenance, thought/research links; reject changed hash, unexpected table/column, broken references, nonempty targets, cross-owner references; rollback on late failure.
- [x] Run `npm test -- tests/library-backup.test.ts tests/backup-routes.test.ts`: expected RED.
- [x] Implement hardcoded table allowlist, owner remapping only at row boundary, schema compatibility checks, self-reference handling, bounded request reader and origin/auth checks. Preview before explicit restore action. Existing export stays available.
- [x] Implement download, file selection, count preview and restore UI. Repeated same-file restore to a nonempty target remains rejected rather than duplicating data.
- [x] Run unit/full suite, typecheck and browser flow: expected PASS. Rehearse a read-only live backup in a separate local PGlite database and compare restored table hashes; never restore into the live account.
- [x] Commit this task and the rehearsal summary without private data.

### Task 3: 서버 검색·페이지 목록과 가벼운 초기 화면

**Files:** `src/server/book-catalog.ts`, `src/server/library-store.ts`, `src/lib/domain.ts`, `src/app/page.tsx`, `src/app/api/library/route.ts`, `src/app/api/books/route.ts`, `src/app/api/books/[id]/route.ts`, `src/components/use-book-catalog.ts`, `src/components/book-picker.tsx`, `src/components/library-app.tsx`, `src/components/library-forms.tsx`, `src/components/knowledge-panel.tsx`, `tests/book-catalog.test.ts`, `e2e/book-catalog.spec.ts`.

**Interfaces:** `readBookPage(db, owner, query)` returns bounded items, total and next cursor; stable ordering with ID tie-break, owner/query-bound cursor. `readBookDetail` returns one full record. `store.overview(owner)` returns compact books needed by all cycles/notes plus a first page and aggregate catalog counts. Legacy `snapshot` stays complete for export and compatibility. Browser `useBookCatalog` cancels/ignores obsolete responses; shared book picker searches remotely when catalog metadata is present.

- [x] Test owner separation, tied sort pagination, literal search, filters, malformed/mismatched cursors, compact overview preserving calendar and note references.
- [x] Run `npm test -- tests/book-catalog.test.ts`: expected RED.
- [x] Implement bounded queries and detailed book endpoint; attach current provider covers to returned books only. Keep overview and counts in one repeatable-read transaction.
- [x] Wire initial load, list/search/sort/filter/load-more, full detail loading, aggregate counts and remote book selectors. Demo fixtures without catalog metadata retain local behavior.
- [x] Test browser search beyond first page, delayed response, detail/edit and note selection. Run `npm test`, `npm run typecheck`, browser suite and production build: expected PASS.
- [x] Commit this task; final fresh-context whole-change review; fix Important/Critical with regression tests; record limitations. Keep branch local.
