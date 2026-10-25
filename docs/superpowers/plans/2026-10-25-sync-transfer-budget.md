# Sync Transfer Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 변경분의 실제 DB 반환량을 제한하고 중복 값을 제거하면서 기존 동기화 커서와 모든 자료를 보존한다.
**Architecture:** 기존 이벤트 페이지를 사용하고 DB 내부에서 값 구성·중복 제거·용량별 prefix 선택을 수행한다. 행 표현은 전체 scan과 공유한다. 생성 PGlite DB에서 반환 바이트와 왕복 자료를 검증한다.
**Tech Stack:** TypeScript, PostgreSQL/PGlite, Vitest, 기존 Next.js Route Handler.
**Spec:** docs/superpowers/specs/2026-10-25-sync-transfer-budget.md

## Global Constraints

- 운영 Neon 조회·스키마 변경·실기기 동기화 검수는 하지 않는다. 11월 1일 검수 목록을 유지한다.
- 기존 커서·SYNC_PROTOCOL=1·미전송 입력·전체 저장 범위를 유지한다.
- 한 페이지 MAX_JSON_RESPONSE_BYTES=512*1024, 여유 공간 16384 bytes. 기존 조각 크기 192 KiB.
- 사용자가 E:에 하나로 모은 현재 checkout을 사용하되 별도 기능 브랜치에서 작업한다. 새로운 원본 사본은 만들지 않는다.

## Review Focus

- A/B/A/C 이벤트에서 C가 다음 페이지로 밀릴 때 B/A를 처리한 커서만 전진하고 C는 반드시 다음에 전달된다.
- 여러 테이블의 역순 키와 bigint 이벤트 순서, 삭제 후 복원 및 계정 경계를 보존한다.
- 큰 원본은 조각 해시·값을 그대로 검증하고, 누락 행은 커서를 넘기지 않는다.
- 페이지별 실제 DB 반환 JSON 합계가 응답 한도 이내이며 변경 없음에서는 본문을 읽지 않는다.
- 기존 기기/구버전 요청의 재개와 새 미전송 메모가 최적화로 유실되지 않는다.

### Task 1: DB 내부 변경분 용량 제한

**Files:** src/server/sync/read.ts, src/server/sync/values.ts, src/server/sync/change-values.ts, tests/sync-transfer-budget.test.ts
**Interfaces:** selectSyncChangePage(tx, owner, events) -> Promise<{rows: SyncRow[]; after: string}>. 기존 SyncPage/커서는 변경하지 않는다.

- [x] 생성 자료 200건을 사용해 DB 반환량·응답량·누락 없음·중복 제거·혼합 테이블·삭제·복원·누락 행을 검증하는 회귀 검사를 작성한다.
- [x] 기존 코드에서 과다 반환과 반복 키 검사 실패를 확인한다.
- [x] SQL 행 표현을 공유하고 이벤트의 첫 등장 순서에 따라 DB 내부에서 제한한다. 제외된 첫 이벤트 이전까지만 커서를 전진한다.
- [x] sync-transfer-budget, sync-read, sync-change-order, sync-bootstrap-races, sync-redaction, sync-retention 검사를 통과시킨다.
- [x] 변경과 수치를 기록하고 커밋한다.

### Task 2: 기존 기기 흐름과 배포 검증

**Files:** tests/sync-transfer-budget.test.ts, docs/operations/sync-transfer-budget-2026-10-25.md, docs/operations/sync-acceptance-2026-11-01.md
**Interfaces:** 기존 sqlSyncTransport, createMemoryReplica, bootstrapReplica, pullReplica 사용. 새 API/저장소는 추가하지 않는다.

- [x] 생성 DB와 기기로 초기 저장→변경 없는 확인→메모 1개 변경→재개 흐름의 바이트·자료 일치를 검증한다. 기존 outbox를 보존한다.
- [x] 관련 동기화·복제 검사와 typecheck/build/산출물 검사를 실행하고 수치와 제한을 기록한다.
- [x] 전체 변경을 한 번 별도 검토받고 중요한 결함을 수정·검증한다.
- [ ] 기존 승인 범위의 배포 절차로 웹 배포를 갱신한다. 운영 DB를 호출하는 동기화 검사는 하지 않는다. PC 실행본이 별도인 점을 확인하고 중단 없는 반영 방법을 결정한다.
