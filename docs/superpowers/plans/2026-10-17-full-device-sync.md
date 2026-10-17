# 지식서재 전체 기기 복제와 변경분 동기화 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user has already chosen direct sequential implementation; preserve that choice. Obtain one independent review of the whole change before production rollout.

**Goal:** 본인 계정의 온라인 서재 자료 전체를 PC·아이폰에 저장하고, 조회는 기기에서, 동기화는 변경분으로 처리한다.

**Architecture:** 기존 업무 테이블을 유지하고 계정별 확정 순번·변경 알림·행별 순번을 추가한다. 인증된 분할 전송으로 전체 IndexedDB 복제본을 만들고, 이후 변경분 다운로드와 영속적인 보낼 목록을 적용한다. 계정·세대·저장 엔진·조회·동기화·UI를 분리한다.

**Tech Stack:** 기존 Next.js/React/TypeScript, Neon PostgreSQL와 `pg`, 브라우저 IndexedDB·Web Worker·Service Worker, Vitest/PGlite와 Playwright. 새 유료 서비스·로컬 AI·네이티브 앱을 추가하지 않는다.

**Spec:** `docs/superpowers/specs/2026-10-17-full-device-sync-design.md` — 2026-10-17 사용자가 “설계 승인 — 구현 계획 작성”으로 승인함. 이 계획은 구현 전 사용자 확인 대상이다.

## Global Constraints

- 일부 목록 캐시가 아니라 온라인 업무 자료 **전체**를 저장한다. 수정 이력·검토 후보·제외 자료·이미지·원본 가져오기 데이터까지 포함한다.
- 외장 PDF 원본·본문 색인·OCR 중간파일은 복제하거나 수정하지 않는다.
- 인증 세션·비밀키·접근 토큰·서버 실행 자격증명·다른 계정 자료는 복제하지 않는다.
- 기준 실측은 38개 테이블·160,281행·232,636,353바이트(221.86MiB)다. 초기 작업 공간은 약 1GiB로 검수하되 실제 최대 사용량을 측정한다.
- 5,208건 제외·37건 보류·복원·재색인 후 제외 유지·기존 독서 통계와 기기별 페이지 설정을 보존한다.
- 다운로드와 재구성은 준비 세대에서 수행한다. 검증 전 기존 사본·미전송 입력을 삭제하지 않는다.
- 변경 알림 보존은 기본 180일이다. 업무 수정 이력과 제외 상태의 보존 기간과 구분한다.
- 서버가 처리한 요청 ID는 재시도에서도 그대로 쓴다. 사용자 글의 충돌을 마지막 저장값으로 자동 덮어쓰지 않는다.
- 사용자에게 모든 자료가 준비되기 전에 ‘전체 저장 완료’라고 표시하지 않는다. 표지·과거 자료를 LRU로 자동 삭제하지 않는다.
- 같은 체크아웃을 사용하고 `next-env.d.ts`의 기존 변경은 건드리지 않는다. Next 문서는 해당 작업 전에 로컬 `node_modules/next/dist/docs/`에서 확인한다.
- 로컬 빌드는 `node scripts/next-runtime.mjs build --webpack`을 사용한다. 실행 중인 PC 배포 폴더에서 빌드하지 않는다.
- 직접 순차 구현 후 전체 검토 1회. 개별 작업마다 서브에이전트를 새로 만들지 않는다.

## Review Focus

1. **초기 다운로드 중 쓰기·삭제·삽입:** 기본키 스캔을 지나간 자료도 변경분으로 따라잡고 누락 없이 완료해야 한다. Task 5·8에서 고정한다.
2. **같은 메모의 연속 오프라인 수정과 응답 유실:** 중복 생성·구버전 덮어쓰기 없이 입력 순서와 원문을 보존한다. Task 12·13에서 고정한다.
3. **수집기의 직접 SQL·복원·늦은 커밋:** 웹 입력만 추적하거나 미확정 순번을 건너뛰지 않는다. Task 2·3에서 고정한다.
4. **아이폰 저장 부족·웹앱 업데이트·계정 전환:** 전체 저장 완료 표시가 거짓이 되거나 기존 사본·미전송 입력이 사라지지 않는다. Task 6·8·14·15에서 고정한다.
5. **현재 222MiB급 자료와 큰 한 행:** 전체 자료를 한 JSON/메모리 객체로 처리하지 않고, 큰 원본 JSON·이미지도 모두 저장한다. Task 4·7·16에서 고정한다.

## 파일과 책임

- `src/lib/replica/`: 전송 계약·자료별 공개 필드·키·해시 규칙·로컬 자료 투영. 서버 모듈과 비밀정보를 브라우저 번들에 넣지 않는다.
- `src/server/sync/`: DB 추적·분할 읽기·권한·기기 확인. 기존 업무 쓰기를 교체하지 않고 공통 거래 경계를 연결한다.
- `src/client/replica/`: IndexedDB, 전체 받기, 보낼 목록, 충돌·검색·자료 조회와 동기화 조정.
- `src/app/api/sync/`: 세션 확인, 허용된 요청만 위 서버 모듈로 전달한다.
- `src/components/replica/`: 앱 진입 공급자·상태·설정·충돌 UI. 기존 화면의 외형과 페이지 설정을 유지한다.

## 공통 인터페이스

순번은 JavaScript 정밀도 손실을 피하기 위해 10진수 문자열로 다룬다. 기존 업무 버전과 동기화 순번은 서로 다른 값이다.

```ts
type SyncRevision = string;
type SyncEntity = keyof typeof syncEntities;
type SyncKey = string; // owner를 제외한 기본키들을 순서가 고정된 JSON 배열로 직렬화
type SyncRow = {
  entity: SyncEntity; key: SyncKey; revision: SyncRevision;
  deleted: boolean; sha256: string | null; bytes: number;
  inline?: string; // 정확한 원본 수치와 해시를 보존하는 직렬화된 JSON
  parts?: { index: number; bytes: number; sha256: string }[];
};
type SyncPage = {
  epoch: string; head: SyncRevision; cursor: string;
  rows: SyncRow[]; hasMore: boolean;
};
type ReplicaCheckpoint = {
  owner: string; generation: string; epoch: string;
  cursor: string; complete: boolean;
};
type OutboxEntry = {
  owner: string; requestId: string; entityId: string;
  baseVersion: number | null; baseRevision: SyncRevision | null;
  family: 'library' | 'knowledge' | 'thought-map' | 'catalog' | 'exclusions';
  command: unknown; order: number; dependsOn: string[];
  state: 'pending' | 'sending' | 'conflict' | 'failed';
};
```

응답의 최대 JSON 크기는 512KiB, 큰 값의 한 조각은 최대 192KiB로 한다. 문자열 길이 대신 UTF-8 바이트 수를 검사한다. 처음 구현의 동시에 받는 요청 수는 최대 2개다.

### Task 1: 전체 자료 계약과 비밀 필드 경계

**Files:** Create `src/lib/replica/contracts.ts`, `src/lib/replica/entities.ts`, `src/lib/replica/codec.ts`; Test `tests/replica-contracts.test.ts`.

**Interfaces:** `syncEntities`, `projectSyncRow(entity,row): Record<string,unknown>`, `syncKey(entity,row): SyncKey`, `encodeSyncValue(row): Uint8Array`. `SyncRow`·`SyncPage`·`OutboxEntry`의 Zod 검증을 제공한다.

- [x] RED: `includes_all_owner_application_tables`에서 아래 38개 자료 유형을 명시적으로 비교한다. `rejects_secret_fields_and_foreign_keys`에서 `token_hash`, `lease_token`, MCP 인증값, 허용되지 않은 자료 이름, 다른 계정의 키를 거절한다.
- [x] 실행: `node node_modules/vitest/vitest.mjs run tests/replica-contracts.test.ts`; 아직 없는 계약 때문에 실패해야 한다.
- [x] 공개 필드와 기본키를 각 유형에 명시한다. 서버 접속 정보나 전체 `information_schema`를 클라이언트 요청에 따라 노출하지 않는다. 큰 문자열·배열·날짜·null과 원본 JSON의 내용이 직렬화 왕복에서 보존되게 한다.
- [x] GREEN: 위 검사와 `node node_modules/typescript/bin/tsc --noEmit` 통과 후 커밋한다.

대상 테이블: `library_ai_policy`, `library_ai_usage`, `library_analysis_devices`(안전 필드), `library_analysis_feedback`, `library_annual_metrics`, `library_assist_receipts`, `library_assist_requests`(lease 비밀 제외), `library_assist_results`, `library_book_exclusions`, `library_book_introductions`, `library_book_relations`, `library_books`, `library_catalog_reviews`, `library_connections`, `library_cover_assets`, `library_cover_mirrors`, `library_curation_items`, `library_curation_runs`, `library_cycles`, `library_documents`, `library_evolution_candidates`, `library_external_links`, `library_field_origins`, `library_imports`, `library_note_trash`, `library_notes`, `library_operations`, `library_reference_sources`, `library_research`, `library_research_items`, `library_research_placements`, `library_revisions`, `library_shelves`, `library_thought_events`, `library_thought_jobs`, `library_topic_links`, `library_topic_memberships`, `library_topics`.

### Task 2: 같은 거래 안의 변경 기록과 확정 순번

**Files:** Create `db/026_device_sync.sql`, `src/server/sync/write.ts`; Modify `scripts/migrate.ts`, `db/operations/provision-web-runtime.sql`, `tests/helpers/database.ts`; Test `tests/sync-tracking.test.ts`, `tests/sync-concurrency.test.ts`.

**Interfaces:** `withSyncWrite<T>(db,owner,fn): Promise<T>`; DB 테이블 `library_sync_heads`, `library_sync_changes`, `library_sync_row_versions`, `library_sync_devices`. Task 1의 자료 이름·기본키를 사용한다.

- [x] RED: 삽입·수정·삭제·복합키·같은 행의 중복 갱신·거래 롤백을 검사한다. 병렬 거래에서 먼저 번호를 얻고 늦게 커밋한 변경을 클라이언트가 건너뛰지 않는 시나리오를 추가한다.
- [x] 실행: `vitest run tests/sync-tracking.test.ts tests/sync-concurrency.test.ts`; 추적이 없어 실패해야 한다.
- [x] 계정 잠금→업무 쓰기→트리거 추적 순서로 구현한다. 순번은 bigint이고 사용자별로 직렬화한다. 동일 거래 내 반복 행은 마지막 상태로 압축할 수 있지만 커서 범위의 삭제를 누락하지 않는다. 강한 권한이 필요한 함수는 고정 search_path와 제한된 실행 권한을 사용한다.
- [x] PGlite에서는 원자성을, 만료되는 Neon 복제 브랜치에서는 별도 연결의 실제 커밋 순서·교착 복구를 검증한다. 런타임에 광범위한 DELETE·인증 테이블 접근을 새로 주지 않는다. 통과 후 커밋한다.

### Task 3: 웹·수집기·가져오기·복원 쓰기 경로 연결

**Files:** Modify `src/server/library-store.ts`, `import-store.ts`, `pdf-catalog-import.ts`, `library-backup.ts`, `book-exclusions.ts`, `knowledge-store.ts`, `thought-map-store.ts`, `catalog-review-store.ts`, `book-covers.ts`, `cover-mirrors.ts`, `curation-store.ts`, `assist-store.ts`, `ai-usage-store.ts`; Modify 직접 쓰기 경로인 `scripts/collect-catalog.ts`, `collect-pdf-outlines.ts`, `collect-printed-toc.ts`, `collect-yes24.ts`, `enrich-catalog.ts`, `identify-pdfs.ts`, `mirror-book-covers.ts`, `import-catalog-reviews.ts`, `import-ireaditnow.ts`, `import-pdf-catalog.ts`, `adopt-collected-classifications.ts`, `migrate-reading.ts`, `exclude-reviewed-materials.ts`; Create `docs/operations/sync-writers.md`; Test `tests/sync-writers.test.ts`.

**Interfaces:** Task 2의 `withSyncWrite`를 재사용한다. 이미 열린 거래에는 같은 실행자를 전달해 중첩 BEGIN을 만들지 않는다.

- [x] RED: 각 사용자 변경, 제공자 도서정보 갱신, 이미지 저장, 가져오기 재실행, 제외·복원·휴지통 비우기·백업 복원 후 해당 자료의 순번이 바뀌는지 확인한다. 버전 번호가 그대로인 직접 SQL 변경도 포함한다.
- [x] 실행: `vitest run tests/sync-writers.test.ts tests/book-exclusions.test.ts tests/library-backup.test.ts`; 누락된 추적/잠금 경로를 확인한다.
- [x] 쓰기 경로 목록을 `rg`로 실제 조사해 문서화하고 공통 거래 경계를 연결한다. 기존 자료 변경·외부 호출·비용 정책은 그대로 유지한다. 이미 처리된 요청의 재실행은 새 업무 이력을 만들지 않는다.
- [x] 위 검사와 기존 저장·수집·복원 관련 검사를 통과하고 커밋한다. 실제 운영 자료의 내용을 검사용으로 수정하지 않는다.

### Task 4: 전체 읽기와 큰 값 조각 전송 API

**Files:** Create `src/server/sync/read.ts`, `values.ts`, `registry.ts`; Create `src/app/api/sync/meta/route.ts`, `scan/route.ts`, `changes/route.ts`, `value/route.ts`; Test `tests/sync-read.test.ts`, `tests/sync-routes.test.ts`.

**Interfaces:** `readSyncMeta(db,owner)`, `scanSyncRows(db,owner,{entity,after,limit})`, `readSyncChanges(db,owner,{epoch,cursor,limit}): Promise<SyncPage>`, `readSyncValuePart(db,owner,{entity,key,revision,index}): Promise<Uint8Array>`. 메타 정보는 세대·헤드·전체 자료 수·크기 추정·보존 범위를 포함한다.

- [x] RED: 미인증401, 다른 계정 커서 거절, 잘못된 자료/키/순번, 응답 512KiB 제한, 4MiB JSON 한 행과 이미지 전체 조립, 읽는 중 변경409, 읽기 부작용 없음을 검증한다.
- [x] 실행: `vitest run tests/sync-read.test.ts tests/sync-routes.test.ts`에서 미구현 기능의 실패를 확인한다.
- [x] 허용된 SQL 식별자로 행을 투영한다. 짧은 읽기 일관성 거래에서 헤드와 최신 행 순번을 함께 읽는다. 큰 값은 DB에서 바이트를 잘라 전송하며 매 요청마다 4MiB를 받아 192KiB만 잘라 쓰지 않는다. 정규화·해시는 UTF-8·UTC·고정 키 형식을 사용한다.
- [x] 응답은 `private, no-store`로 한다. 파서 상한·다른 계정의 이미지 접근·DB 권한을 검증하고 통과 후 커밋한다.

### Task 5: 최초 스캔과 변경분의 일관성

**Files:** Create `src/server/sync/coverage.ts`; Extend Task 4 APIs; Create `tests/sync-bootstrap-races.test.ts`, `scripts/verify-sync-branch.ts`.

**Interfaces:** `readSyncCoverage(db,owner): Promise<{epoch,head,entities: Record<SyncEntity,{rows:number,sha256:string}>}>`. 허용된 행의 키와 내용 해시를 고정 순서로 집계한다.

- [x] RED: 이미 스캔한 키 범위의 삽입, 페이지 사이의 삭제·수정, 표지 변경, 시작 후 제외·복원, 아직 동기화 순번이 없는 기존 행까지 검증한다.
- [x] 실행: `vitest run tests/sync-bootstrap-races.test.ts`. 복제 브랜치에서 `verify-sync-branch.ts`의 여러 연결 시나리오도 실행한다.
- [x] 시작 커서→전체 테이블 키 순서 스캔→변경분 따라잡기→같은 헤드의 coverage 검사를 구현한다. 장시간 DB 거래·공유 서버 메모리·새 유료 스냅샷 서비스에 의존하지 않는다.
- [x] 행 수와 내용 해시가 모두 맞아야 준비 완료다. 계속되는 변경은 전체 재전송 대신 차이로 따라잡고, 불일치 자료를 다시 확인한다. 통과 후 커밋한다.

### Task 6: IndexedDB의 세대·원자성·계정 분리

**Files:** Create `src/client/replica/storage.ts`, `indexed-db.ts`, `memory-storage.ts`; Test `e2e/replica-storage.spec.ts`, `tests/replica-storage-contract.test.ts`.

**Interfaces:** `openReplica(owner): Promise<ReplicaStorage>`. 저장 어댑터는 `stageRows(generation,rows)`, `putValuePart(...)`, `readRow(...)`, `readPage(...)`, `transaction(fn)`, `checkpoint()`, `promoteGeneration(...)`, `close()`를 제공한다. 저장 거래 안에서 통신 완료를 기다리지 않는다.

- [x] RED: 저장 실패 시 기존 세대 유지, 원자적 세대 전환, 계정 분리, 여러 탭과 versionchange, 재구성 후에도 미전송 입력 유지 여부를 실제 IndexedDB로 검증한다.
- [x] 실행: `playwright test e2e/replica-storage.spec.ts`와 저장 계약 유닛 검사. 새 의존 패키지를 추가하지 않고 같은 계약의 메모리 어댑터로 순수 처리도 검증한다.
- [x] 메타·자료·값 조각·파생 색인·송신 대기·충돌을 분리한다. 키에 계정과 세대를 포함하고 저장 실패를 성공으로 반환하지 않는다.
- [x] 재로딩·오프라인 재시작·DB 스키마 갱신·중간 중단을 검사하고 통과 후 커밋한다.

### Task 7: 큰 값·전체 표지·재개 가능한 전체 받기

**Files:** Create `src/client/replica/transport.ts`, `bootstrap.ts`, `values.ts`; Test `tests/replica-bootstrap.test.ts`, `e2e/replica-full-download.spec.ts`.

**Interfaces:** `createSyncTransport(baseUrl)`이 Task 4를 호출한다. `bootstrapReplica({owner,storage,transport,onProgress,signal}): Promise<ReplicaCheckpoint>`, `resolveReplicaImage(assetId): Promise<Blob>`을 제공한다.

- [x] RED: 38개 자료 유형 전체·과거 이력·제외 자료·원본 가져오기 JSON·전체 이미지의 일치, 끊긴 조각부터 재개, 해시 불일치, 원본 변경409 후 재시도를 검증한다.
- [x] 실행: `vitest run tests/replica-bootstrap.test.ts`, `playwright test e2e/replica-full-download.spec.ts`.
- [x] 최대 2개 요청으로 나누어 저장하고 SHA-256 검사를 통과한 조각만 재사용한다. 모든 이미지를 완전히 받고, 표시용 Blob URL은 보이는 이미지에 한해 생성·해제한다. 전체 DB를 한 번에 JSON.parse하지 않는다.
- [x] 탭 종료 후 이어받기와 모든 큰 자료의 보관을 확인한다. 남은 자료가 있으면 `complete=false`여야 한다. 통과 후 커밋한다.

### Task 8: 변경분 적용·보존 기간·다시 구성하기

**Files:** Create `src/client/replica/pull.ts`, `coordinator.ts`, `src/server/sync/retention.ts`; Test `tests/replica-pull.test.ts`, `tests/sync-retention.test.ts`.

**Interfaces:** `pullReplica({owner,storage,transport,signal}): Promise<ReplicaCheckpoint>`, `syncReplica({reason}): Promise<SyncStatus>`, `pruneSyncChanges(db,owner,{before}): Promise<void>`. `SyncStatus`에는 단계·진행 개수/바이트·미전송/실패/충돌 개수·마지막 동기화 시각·오류를 정의한다.

- [x] RED: 추가·삭제·복원·제외의 반복, 순서가 뒤집히거나 중복된 응답, 저장 성공 뒤에만 커서 전진, 삭제 자료 재등장 방지, 180일 지난 기기 재구성을 검증한다.
- [x] 실행: `vitest run tests/replica-pull.test.ts tests/sync-retention.test.ts`.
- [x] 받은 행과 커서를 하나의 저장 거래로 적용한다. 최신 행을 오래된 응답으로 되돌리지 않는다. 보존 범위 밖의 기기는 기존 자료·송신 대기를 유지하며 준비 세대를 다시 만든다.
- [x] 알림 정리가 업무 이력·제외 상태를 지우지 않는지와 초기 스캔 경쟁 조건을 검사하고 통과 후 커밋한다.

### Task 9: 로컬 검색과 화면 자료 리포지토리

**Files:** Create `src/lib/replica/projections.ts`, `src/client/replica/repository.ts`, `queries.ts`, `search-worker.ts`; Test `tests/replica-query-parity.test.ts`, `e2e/replica-queries.spec.ts`.

**Interfaces:** `createReplicaRepository(storage): ReplicaRepository`. `overview()`, `books(query)`, `book(id)`, `notes(query)`, `note(id)`, `reading(query)`, `calendar(month)`, `search(query)`, `history(id)`, `read(route)`는 기존 UI와 맞는 자료 형식을 반환한다.

- [x] RED: 같은 fixture의 SQL/로컬 페이지·개수·분류·태그·띄어쓰기 무시 검색·표지 참조·서울 시간 기준 날짜·제외/휴지통 결과를 비교한다.
- [x] 실행: `vitest run tests/replica-query-parity.test.ts`, `playwright test e2e/replica-queries.spec.ts`.
- [x] 순수 변환을 공용 라이브러리로 분리하되 SQL·Node 전용 모듈은 브라우저에 넣지 않는다. 색인을 워커에서 갱신하고 정렬의 동순위 ID까지 계약으로 고정한다.
- [x] 전체 자료를 보관하면서도 화면에는 필요한 행만 읽는지 검사하고 통과 후 커밋한다.

### Task 10: 첫 화면·목록·상세의 로컬 표시

**Files:** Create `src/components/replica/provider.tsx`, `entry.tsx`, `src/app/api/sync/session/route.ts`; Modify `src/app/page.tsx`, `src/components/library-app.tsx`, `use-paged-resource.ts`, `use-book-catalog.ts`, `book-cover.tsx`, `reading-calendar.tsx`, `note-tag-filter.tsx`, `note-trash.tsx`, `library-search-panel.tsx`; Test `e2e/replica-library.spec.ts`.

**Interfaces:** `ReplicaProvider`, `useReplica()`, `readLibraryResource(path)`. Task 9의 자료가 준비되면 기존 URL 계약을 로컬 조회로 처리한다. 최초 준비 중에는 기존 온라인 경로를 명시적으로 사용한다.

- [x] RED: `/api/library`와 목록 API가 응답하지 않아도 준비된 기기에서 홈·전체 도서 검색·상세·표지·전체 메모·이력이 열리는지 검증한다.
- [x] 실행: `playwright test e2e/replica-library.spec.ts e2e/list-pagination.spec.ts e2e/note-mobile.spec.ts`.
- [x] 첫 HTML의 DB overview 대기를 없애고 가벼운 클라이언트 셸로 진입한다. 최초 인증은 세션 API로, 기존 사본의 오프라인 읽기는 기기 저장소로 처리한다. 온라인 조작 권한은 계속 서버가 검증한다. 기존 로그인과 돌아올 주소를 유지한다.
- [x] 저장 뒤 overview 재다운로드를 로컬 다시 읽기로 바꾸고, 목록이 빈 화면으로 바뀌지 않는지 검사한 뒤 커밋한다.
- [x] 사용자의 추가 요청대로 ‘나의 서재’ 상단 ‘책 추가’ 왼쪽에 ‘동기화’를 배치한다. Task 8의 실제 `syncReplica`에 연결하고 중복 실행 방지·진행/결과를 표시한다. 버튼이 전체 DB 재다운로드를 실행하거나 동작 없이 성공을 표시하지 않는지 E2E로 확인한다.

### Task 11: 과거 이력·검토·지도·연구·AI 결과도 로컬 조회

**Files:** Extend `src/client/replica/queries.ts`, `projections.ts`; Modify `book-introduction.tsx`, `book-relations.tsx`, `catalog-review-panel.tsx`, `curation-details.tsx`, `knowledge-panel.tsx`, `research-board.tsx`, `book-exclusions.tsx`, `assist-panel.tsx`, `thought-map/panel.tsx`, `thought-map/manual-comparison.tsx`, `thought-map/device-settings.tsx`, `library-operations.tsx`, `backup-panel.tsx`; Test `e2e/replica-all-data.spec.ts`.

**Interfaces:** Task 9의 `read(route)`에 모든 로컬 자료 조회를 등록한다. 등록하지 않은 외부 API를 임의로 네트워크에 넘기지 않고 외부 기능으로 명시한다.

- [x] RED: 오프라인에서 검토 후보 전체·원본 정보·출처·모든 이력·지도·연구·제외 목록·저장된 AI 결과와 비용을 참조할 수 있는지 검증한다.
- [x] 실행: `playwright test e2e/replica-all-data.spec.ts`와 기존 지도·검토 검사를 실행한다.
- [x] 기본 화면뿐 아니라 세부 창을 열 때 남은 fetch도 연결한다. PDF 본체/PC 처리 상태, 온라인 도서 검색, 로그인/연결 관리, AI 실행은 온라인 기능이다. 이미 저장된 자료의 열람을 온라인 필수로 만들지 않는다.
- [x] 로컬 전체 자료 내보내기에 과거 정보가 포함되는지 확인하고 통과 후 커밋한다.

### Task 12: 로컬 편집·영속 송신 대기·자료 ID

**Files:** Create `src/client/replica/outbox.ts`, `optimistic.ts`, `push.ts`, `src/server/sync/commands.ts`, `src/app/api/sync/push/route.ts`; Modify `src/lib/domain.ts`, `src/server/library-store.ts`, `knowledge-store.ts`, `thought-map-store.ts`, `book-exclusions.ts`, `src/components/library-app.tsx`; Test `tests/replica-outbox.test.ts`, `tests/sync-commands.test.ts`, `e2e/replica-editing.spec.ts`.

**Interfaces:** `queueReplicaCommand(storage,entry): Promise<void>`, `pushReplica({owner,storage,transport}): Promise<PushReport>`. `PushReport`는 확정한 요청·남은 요청·충돌·실패를 구분한다. 서버는 family별 기존 명령 검증·권한·version/requestId를 사용하며 임의 행 업로드를 허용하지 않는다.

- [x] RED: 같은 메모를 오프라인에서 3번 수정, 서버 성공 뒤 응답 유실, 재시작, 새 책과 메모의 의존성, 편집 뒤 오래된 응답 수신을 검증한다.
- [x] 실행: `vitest run tests/replica-outbox.test.ts tests/sync-commands.test.ts`, `playwright test e2e/replica-editing.spec.ts`.
- [x] 표시용 변경과 보낼 명령을 원자적으로 저장한다. 후속 입력을 과거 명령의 성공 응답으로 덮어쓰지 않는다. 새 UUID 검증과 기존 API 호환성을 유지하고 거절된 입력을 보존한다.
- [x] AI를 자동 실행하지 않고 비용 예약이 중복되지 않으며 서버 응답으로 새 입력이 사라지지 않는지 확인한 뒤 커밋한다.

### Task 13: 충돌 해결과 기존 오프라인 기록 이전

**Files:** Create `src/client/replica/conflicts.ts`, `src/components/replica/conflict-review.tsx`; Modify `src/lib/offline-drafts.ts`, `src/components/offline-drafts.tsx`, `public/offline.js`; Test `tests/replica-conflicts.test.ts`, `e2e/replica-conflicts.spec.ts`.

**Interfaces:** `resolveReplicaConflict({entry,base,latest,choice,text}): OutboxEntry`, `migrateLegacyDrafts(storage,legacy,owner): Promise<MigrationReport>`. 해결본은 새 요청 ID와 최신 expectedVersion을 사용한다. `MigrationReport`에 이전·이미 이전됨·실패·원본 보존 개수를 정의한다.

- [ ] RED: PC/iPhone에서 같은 글 수정, 다른 기기의 삭제·제외, 해결 중 새 수정, 이전 중 용량 부족, localStorage와 IDB에 같은 입력이 있는 경우를 검증한다.
- [ ] 실행: `vitest run tests/replica-conflicts.test.ts`, `playwright test e2e/replica-conflicts.spec.ts`.
- [ ] 기준·기기 입력·최신 내용을 비교하고 사용자 선택으로 통합한다. 원문을 잃지 않으며 기존 임시 기록은 새 저장 검증 후에만 이전 완료로 처리한다.
- [ ] 최신 버전 확인·닫기·재시도·원문 내보내기를 확인하고 통과 후 커밋한다.

### Task 14: 앱 코드의 오프라인 시작과 업데이트

**Files:** Modify `public/sw.js`, `public/offline.html`, `public/offline.js`, `src/app/manifest.ts`, replica entry/provider; Test `e2e/replica-pwa.spec.ts`.

**Interfaces:** 버전이 있는 공개 셸/JS/CSS/아이콘만 캐시한다. Task 10의 진입 화면을 오프라인에서 여는 공개 셸을 마련하고 개인 자료는 Task 6의 DB에서 읽는다.

- [ ] RED: Background Sync 미지원, 준비 후 완전 오프라인 시작, SW 갱신 중 미전송 기록, 구/신 버전 탭 공존, 로그아웃 후 다른 계정에서 이전 자료 열람 금지를 검증한다.
- [ ] 실행: `playwright test e2e/replica-pwa.spec.ts e2e/google-login.spec.ts`.
- [ ] 인증 HTML·일반 API 응답·PDF를 공용 Cache에 저장하지 않는다. 호환되지 않는 DB 변경은 구 상태를 보존하며 안내하고 강제 새로고침으로 입력을 지우지 않는다.
- [ ] 시작·복귀·연결 복구·저장·수동 동기화를 검사하고 통과 후 커밋한다. 닫힌 iPhone의 상시 실행에 의존하지 않는다.

### Task 15: 전체 저장 상태·용량·여러 탭

**Files:** Create `src/components/replica/sync-settings.tsx`, `sync-status.tsx`, `src/client/replica/device.ts`, `leadership.ts`; Modify `src/components/library-app.tsx`, `src/app/globals.css`; Test `e2e/replica-settings.spec.ts`, `tests/replica-leadership.test.ts`.

**Interfaces:** `readStorageStatus(): Promise<{usage,quota,persisted}>`, `requestPersistentStorage()`, `withReplicaLeader(owner,fn)`. 상태 표시는 Task 8의 `SyncStatus`를 사용한다.

- [ ] RED: 영속 저장 거절/미지원, 용량 부족 후 재개, 로그아웃, 미전송 입력이 있는 재구성, 두 탭의 동시 전송과 한 탭 종료를 검증한다.
- [ ] 실행: `playwright test e2e/replica-settings.spec.ts`, `vitest run tests/replica-leadership.test.ts`.
- [ ] ‘기기에 저장됨’과 ‘동기화 완료’를 구분한다. 이미지/큰 값을 덜 받았으면 미완료이며 전체 저장 모드에 LRU를 넣지 않는다. 미전송 입력을 보관·내보내기 전의 기기 자료 삭제를 막는다.
- [ ] 짧은 설정 설명과 사용법 상세를 제공한다. 기기마다 저장 진행률이 독립적이며 페이지 이동에 일괄 로딩이 생기지 않는지 검사하고 통과 후 커밋한다.

### Task 16: 실제 규모·변경분 통신·전체 화면 검증

**Files:** Create `scripts/verify-replica.ts`, `e2e/replica-multidevice.spec.ts`, `e2e/replica-transfer-budget.spec.ts`, `docs/operations/full-device-sync.md`.

**Interfaces:** `verify-replica.ts --mode verify-only`는 개인 자료의 내용을 수정하지 않고 자료 수·해시·저장/전송량·시간을 보고한다. 자동 수정 검사는 일회성 환경과 fixture만 사용한다.

- [ ] 16만 행/222MiB 수준, 4MiB 이상 한 행, 전체 표지를 가진 생성 자료로 메모리·최대 저장량·중단 복구를 검사한다. 개인 자료는 CI에 보내지 않는다.
- [ ] 변경이 없을 때 확인 응답 4KiB 이하, 전체 자료/이미지 재전송 0, 메모 한 건 수정 시 관련 변경·이력만 전송됨을 네트워크 측정으로 검증한다.
- [ ] 독립된 두 브라우저 저장소로 왕복 동기화·충돌·삭제·제외/복원·오래된 기기 복귀를 검증한다. 외장 PDF를 복제하지 않는지도 확인한다.
- [ ] 전체 Vitest·타입 검사·webpack build·배포 산출물 검사·인증을 포함한 전체 E2E/CI를 통과한다. 로컬 준비 후 PC p95 200ms/iPhone p95 400ms를 실측하고 미달이면 실제 결과를 밝힌 뒤 병목을 수정한다.
- [ ] iPhone의 최종 확인은 직접 조작이 필요한 부분만 사용자에게 요청한다. 실제 필요 공간과 최초 전송량을 기록하고 커밋한다.

### Task 17: 전체 검토와 운영 전환

**Files:** 전체 변경과 운영 검증 기록. 기존 제한 권한·빌드·Vercel/PC 배포 방식을 유지한다.

- [ ] 독립적인 전체 검토 1회에서 계정 경계·커밋 순서·전체 테이블·최초 받기 중 변경·미전송 입력·자료 유출·권한·모바일을 확인한다. 중요한 지적을 수정하고 해당 검사를 통과한다.
- [ ] 만료되는 운영 DB 사본에서 스키마·전체 복제·변경분을 검증하고 업무 자료가 그대로인지 확인한다.
- [ ] 운영에는 추가 스키마와 변경 추적을 먼저 적용한다. 전체 받기와 일치를 확인한 본인 기기부터 로컬 표시를 켜고 기존 온라인 경로는 유지한다.
- [ ] 새 불변 PC 리리스와 웹에 배포하고 공개/PC 원문 링크를 검사한다. 큰 DB·PDF·비밀 설정이 배포물에 들어가지 않았는지 확인한다.
- [ ] 되돌릴 때 추적 로그·송신 대기를 버리지 않고 온라인 조회로 복귀한다. 새 UI에만 미전송 입력이 있으면 먼저 업로드·내보내기를 안내한다.
- [ ] PC·iPhone 각각 전체 저장 완료, 다음 변경의 왕복 동기화를 확인해 완료한다. 사용자가 할 일은 홈 화면 추가·본인 로그인·실기기 최종 확인으로 구분해 안내한다.

## 계획 검토와 실행 방법

기존에 선택한 **직접 순차 구현**을 유지한다. 설계는 승인됐으며 이 계획 확인 뒤 구현을 시작한다. 각 작업은 실패 재현→구현→검사 통과→커밋으로 진행하고, 전체 저장 전환이 끝날 때까지 기존 온라인 경로를 유지한다.
