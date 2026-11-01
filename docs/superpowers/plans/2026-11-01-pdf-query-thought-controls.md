# PDF 검색과 생각묶음 조작 수정 계획

> **For agentic workers:** Use systematic debugging and test-driven development. Independent PDF query, replica investigation, and canonical deletion tasks run in parallel; board controls are integrated by the primary agent.

**Goal:** 요청한 검색 규칙, 동기화 원인 확인, 전체선택, 기본 상자 숨김, 생각묶음 삭제를 기존 기기 저장 구조에 반영한다.

**Architecture:** PDF 검색은 로컬 색인을 읽기만 한다. 따옴표 어구와 일반 단어를 구분하고 검색 결과는 안전한 텍스트로 강조한다. 보드의 표시 선택은 원본과 분리하며, 삭제는 기존 canonical archive 명령과 기기 outbox로 처리한다.

**Tech Stack:** Next.js, React, TypeScript, SQLite FTS5, PostgreSQL, IndexedDB, Vitest, Playwright.

**Spec:** 사용자의 이번 다섯 항목 요청. 추가 설계 선택은 기존 구조를 따른다.

**최신 범위:** 이후 사용자가 현재 수정 마무리 → 가능한 검사 → 커밋·push → 다른 환경에 인수인계를 요청했다. 구현은 완료하고 운영 서버 교체와 실제 기기 검수는 보류한다. 결과와 미검증 항목은 `docs/operations/handoff-2026-11-01.md`를 따른다.

## Global Constraints

- 원본 PDF, 개별 메모, 독서 이력은 삭제하지 않는다.
- 전체 기기 저장은 유지하고 불필요한 검색 후 전송만 제거한다.
- 화이트보드는 연결관리에서 고른 생각묶음만 표시한다. 글감에 저장된 목차는 계속 표시한다.
- 표시 토글은 저장·복제 명령을 발생시키지 않는다.
- 기존 검색 제한과 접근 권한, 삭제 요청의 버전·중복 처리 보장을 유지한다.

## Review Focus

- ASCII/곡선 따옴표와 일반 단어가 섞인 검색, FTS 토큰의 실제 어구 일치.
- 다른 출처의 첫 기기 저장과 기존 저장소의 불필요한 재다운로드 구별.
- 일부 선택 후 전체선택과 다시 전체 해제, 새 상자 추가 후 즉시 표시.
- 수정 중인 상자를 삭제할 때 순서 보장, 삭제한 원본의 늦은 보드 응답 복원 방지.
- 글감의 저장된 상자는 표시 선택과 무관하게 보존하며 원본 삭제 시만 제거.

## Task 1: PDF 검색과 강조

- [ ] 기존 parser/SQLite worker/UI를 조사하고 따옴표 검색 실패를 테스트로 재현한다.
- [ ] `src/local/pdf-search.mjs`에서 어구/단어 AND 검색 및 유효성 검사를 구현한다.
- [ ] `src/components/pdf-library-panel.tsx`의 실제 결과 경로에서 안전한 굵은 강조를 추가한다.
- [ ] SQLite 회귀 및 브라우저 결과 검사를 실행한다.

## Task 2: 대량 동기화 조사

- [ ] PDF GET → origin 전환 → ReplicaEntry → checkpoint/bootstrap 경로를 추적한다.
- [ ] 실제 로그/상태의 건수·단계만 조사하고 개인 본문이나 비밀정보는 출력하지 않는다.
- [ ] 불필요한 읽기 후 sync 및 재bootstrap 원인을 재현 테스트로 고친다.
- [ ] 필수 전체 저장과 미전송 변경이 유지됨을 확인한다.

## Task 3: 연결관리 선택과 기본 표시

- [ ] `tests/whiteboard-display.test.ts`, `e2e/shared-thought-workflow.spec.ts`에서 초기 생각묶음 숨김과 전체선택 두 번 토글을 재현한다.
- [ ] `src/lib/whiteboard-display.ts`에서 일반 보드 생각묶음을 명시적으로 선택한 경우만 표시한다.
- [ ] `src/components/whiteboard/panel.tsx`에서 선택보기 → 전체선택을 구현한다. 일부 선택이면 모두 선택하고 전부 선택이면 모두 해제한다.
- [ ] 글감의 기존 상자 보존과 상자 추가·검색·표시 전환 회귀를 검사한다.

## Task 4: 원본 생각묶음 삭제

- [ ] 기존 `archiveMemoBundle({id, expectedVersion})` 서버/기기 명령의 동작을 재현한다.
- [ ] 원본 삭제 후 연결관리·메모상자·보드에서 사라지고 메모는 보존되는 테스트를 추가한다.
- [ ] 메모상자 상세 및 보드 목록·상자 삭제를 동일한 명령에 연결하고 확인창을 제공한다.
- [ ] 늦은 수정/재조회가 삭제한 원본을 부활시키지 않는지 검사한다.

## Task 5: 통합 확인과 배포

- [ ] 관련 브라우저 검사, 전체 단위 검사, 타입·서식·빌드를 확인한다.
- [ ] 독립 검토 후 확인된 문제를 수정한다.
- [ ] 웹과 비공개 PC에 반영하며 진행 중인 OCR·수집기는 유지한다.
- [ ] 검색 후 대량 동기화의 조사 결과와 사용자가 알아야 하는 동작만 간결하게 보고한다.
