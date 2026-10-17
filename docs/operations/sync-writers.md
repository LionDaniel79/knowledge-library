# 동기화 쓰기 경로

모든 업무 자료는 DB 트리거로 기록한다. 아래 경로는 업무 행 잠금 전에 계정 헤드를 먼저 잠그며, 기존 조회는 쓰기 잠금을 얻지 않는다. `withSyncWrite`는 거래를, `syncQuery`는 한 문장의 직접 쓰기나 기존 거래의 쓰기를 보호한다. 외부 API 호출은 잠금 밖에서 수행한다.

- `src/server/ai-usage-store.ts` · `reserveAiUsage` · transaction · owner
- `src/server/ai-usage-store.ts` · `markAiUsageSending` · transaction · owner
- `src/server/ai-usage-store.ts` · `settleAiUsage` · transaction · owner
- `src/server/assist-store.ts` · `configure` · transaction · owner
- `src/server/assist-store.ts` · `request` · transaction · owner
- `src/server/assist-store.ts` · `heartbeat` · transaction · d.ownerId
- `src/server/assist-store.ts` · `claim` · transaction · d.ownerId
- `src/server/assist-store.ts` · `begin` · transaction · d.ownerId
- `src/server/assist-store.ts` · `renew` · transaction · d.ownerId
- `src/server/assist-store.ts` · `finish` · transaction · d.ownerId
- `src/server/assist-store.ts` · `cancel` · statement · owner
- `src/server/assist-store.ts` · `failClaim` · transaction · d.ownerId
- `src/server/assist-store.ts` · `resolveCost` · transaction · owner
- `src/server/assist-store.ts` · `adopt` · transaction · owner
- `src/server/book-covers.ts` · `upload` · transaction · owner
- `src/server/book-exclusions.ts` · `operation` · transaction · owner
- `src/server/book-introduction.ts` · `saveBookIntroduction` · transaction · owner
- `src/server/book-relations.ts` · `mutate` · transaction · owner
- `src/server/catalog-review-store.ts` · `importCatalogReviewBatch` · statement · owner
- `src/server/catalog-review-store.ts` · `importCatalogReview` · transaction · owner
- `src/server/catalog-review-store.ts` · `decideCatalogReview` · transaction · owner
- `src/server/cover-mirrors.ts` · `storeCoverMirror` · statement · owner
- `src/server/curation-store.ts` · `begin` · statement · owner
- `src/server/curation-store.ts` · `apply` · transaction · owner
- `src/server/curation-store.ts` · `edit` · transaction · owner
- `src/server/curation-store.ts` · `rollback` · transaction · owner
- `src/server/curation-store.ts` · `seal` · statement · owner
- `src/server/import-store.ts` · `apply` · transaction · owner
- `src/server/knowledge-store.ts` · `mutate` · transaction · owner
- `src/server/legacy-reading-store.ts` · `run` · transaction · owner
- `src/server/library-ai-policy.ts` · `retireAutomaticJobs` · statement · owner
- `src/server/library-ai-policy.ts` · `retireAutomaticJobs` · statement · owner
- `src/server/library-backup.ts` · `restoreLibraryBackup` · transaction · owner
- `src/server/library-store.ts` · `mutate` · transaction · owner
- `src/server/note-tags.ts` · `remove` · transaction · owner
- `src/server/pdf-catalog-import.ts` · `importPdfCatalog` · transaction · owner
- `src/server/server-assist.ts` · `acknowledge` · statement · d.ownerId
- `src/server/server-assist.ts` · `runServerAssistStep` · statement · d.ownerId
- `src/server/thought-device-auth.ts` · `issue` · statement · owner
- `src/server/thought-device-auth.ts` · `revoke` · statement · owner
- `src/server/thought-device-auth.ts` · `authenticate` · statement · String(row.owner_id)
- `src/server/thought-job-store.ts` · `claim` · transaction · owner
- `src/server/thought-job-store.ts` · `renew` · statement · owner
- `src/server/thought-job-store.ts` · `finish` · transaction · owner
- `src/server/thought-job-store.ts` · `fail` · transaction · owner
- `src/server/thought-job-store.ts` · `reconcile` · transaction · owner
- `src/server/thought-job-store.ts` · `retry` · statement · owner
- `src/server/thought-map-store.ts` · `mutate` · transaction · owner
- `src/server/thought-map-store.ts` · `saveCandidate` · transaction · owner
- `src/local/curation/catalog-precheck.ts` · `precheckCatalogReviews` · statement · owner
- `src/local/curation/catalog.ts` · `collectBookReference` · statement · owner
- `src/local/curation/pdf-identity-store.ts` · `applyPdfIdentity` · transaction · owner
- `src/local/curation/pdf-outline-store.ts` · `retireUnusablePdfOutlines` · transaction · owner
- `src/local/curation/pdf-outline-store.ts` · `collectPdfOutline` · transaction · owner
- `src/local/curation/printed-toc-store.ts` · `collectPrintedToc` · transaction · owner
- `src/local/curation/verified-classification.ts` · `adoptCollectedClassification` · transaction · owner
- `src/local/curation/yes24-batch.ts` · `applyYes24Supplement` · transaction · owner
- `scripts/enrich-catalog.ts` · `` · statement · owner
- `scripts/migrate-reading.ts` · `` · statement · owners[0].id
- `scripts/verify-library-categories.ts` · `` · statement · owner

도움 함수의 `tx.query`는 이 거래 내부에서만 사용한다. 비공개 인증 토큰 테이블과 전역 호출 제한은 복제 대상이 아니며 기존 권한 경로를 유지한다. 운영용 일괄 제외 스크립트는 기존 거래 안에서 같은 실행자를 전달한다.

공통 저장·수집 도움 함수를 호출하는 명령행 도구도 같은 경계를 거친다. 실제 쓰기는 위 도움 함수에 있으므로 호출 도구마다 이중 거래를 만들지 않는다. 직접 SQL 잔여 조사에서 서버 전용 worker 상태·OAuth 정보·전역 호출 제한만 남는 것을 확인한다.
