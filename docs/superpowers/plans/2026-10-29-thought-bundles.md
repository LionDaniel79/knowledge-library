# 생각 묶음 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. 승인된 직접 순차 구현으로 진행한다.

**Goal:** 한 메모가 여러 독립 생각 묶음에 참여하고 묶음 사이 관계를 편집·동기화한다.

**Architecture:** library_memo_bundles와 library_bundle_links에 버전 자료를 저장한다. /api/knowledge 명령, /api/whiteboard 조회, 기존 기기 복제·충돌·백업을 확장한다. 보드에 bundle:ID 참조를 투영해 모든 보드가 같은 내용과 연결을 사용한다.

**Tech Stack:** 기존 Next16/React19/TypeScript/Postgres/PGlite/IndexedDB/Vitest/Playwright.

**Spec:** docs/superpowers/specs/2026-10-29-thought-bundles-design.md

## Global Constraints

- 분류 주제의 자동 묶음 연결을 중단하고 기존 자료를 보존한다.
- 메모/묶음 연결 해제는 서로 독립이며 유료 AI를 호출하지 않는다.
- 기기 즉시 저장·변경 동기화·계정 격리·버전 충돌·백업을 지원한다.

## Review Focus

- 같은 메모의 여러 묶음 참여와 독립적인 배치.
- 휴지통 메모와 묶음 보관해제 후 원본/연결 보존.
- 다른 계정 ID와 잘못된 버전 거절.
- 묶음 연결 해제 후 메모 연결 보존 및 새로고침 유지.
- 기존 기기에서 전체 재다운로드 없이 새 자료 동기화.

### Task 1: 저장·명령·복제

- [x] tests/thought-bundles.test.ts에 소유자/버전/다중 소속/연결 독립성 회귀 검사 작성 후 실패 확인.
- [x] db031, lib/thought-bundles, server/thought-bundles, knowledge-store, whiteboard-store, optimistic/resources/entities, 백업/권한 경로 구현.
- [x] 서버·로컬·동기화 검사를 실행하고 통과 확인.

### Task 2: 보드 투영

- [x] tests/thought-bundle-board.test.ts에 복수 상자/검색/연결 분리 검사 작성 후 실패 확인.
- [x] whiteboard schema/scene에 bundle: 참조, 저장된 묶음/연결 투영 추가. 기존 주제 자동 연결 표시 제거.
- [x] 보드/글감 회귀 검사 통과.

### Task 3: 메모 상자

- [x] e2e/thought-bundles.spec.ts에 만들기·중복 소속·연결 이유·해제 흐름 작성 후 실패 확인.
- [x] 생각 묶음 관리 UI, 묶음 연결 UI, 기존 연결 메모에서 저장 기능 구현. 원본을 열어 편집한다.
- [x] 데스크톱·모바일 검사 통과.

### Task 4: 화이트보드·글감

- [x] 새/기존 묶음에 메모 추가, 수동 묶음 전환, 묶음 연결/해제 및 관계 편집, 글감 자료 선택을 연결한다.
- [x] 연결선·전체화면·글감/검색/숨김 회귀 검사 실행.

### Task 5: 검토·배포

- [x] 신선한 전체 변경 검토, 중요한 결함 수정 및 검사.
- [x] 타입·기능·빌드 검증, DB 검증 분기/운영에 확장 DDL 적용.
- [ ] 웹/PC 배포 후 로그인/보호 경로·기존 작업 보존 확인. 사용자 사용법 안내.
