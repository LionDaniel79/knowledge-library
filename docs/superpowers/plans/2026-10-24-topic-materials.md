# Topic Materials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 분야·주제·종류·정렬이 일관되게 작동하는 간결한 주제별 자료 화면.
**Architecture:** 서버는 SQL UNION 자료 모델에서 필터·정렬·페이지를 적용하고, 기기/미리보기는 같은 자료 모델의 순수 함수를 쓴다. 주제 관리는 마지막의 접는 영역으로 분리한다.
**Tech Stack:** Next.js 16.4.2, React, TypeScript, PostgreSQL/PGlite, Vitest, Playwright.
**Spec:** docs/superpowers/specs/2026-10-24-topic-materials-design.md

## Global Constraints

- 기존 E 단일 저장소의 별도 브랜치 사용. 실제 DB/동기화 검사는 11/1 보류.
- 원본·제외 자료·메모를 시험용으로 변경하지 않고 유료 AI를 호출하지 않는다.
- 업무 자료와 기기별 표시 설정을 구분하며 주제 순서는 계정별 기기 설정이다.

## Review Focus

- 한 페이지 안에서만 정렬하지 않는다. 메모·책의 전체 정렬 이후 분할.
- 주제가 책에만 지정됐어도 해당 메모를 찾고 명시적 거절/삭제를 존중한다.
- 목록의 수와 실제 카드 수가 같은 필터를 사용한다.
- 표시 개수와 다른 필터의 높이·가로 넘침, 주제 40개 때 첫 기록의 위치.
- 정렬/분야/종류/주제 변경 시 첫 페이지로 복귀하며 계정 간 주제 순서는 섞이지 않는다.

### Task 1: 자료 조회

Files: src/lib/material-query.ts, src/lib/topic-materials.ts, src/server/material-catalog.ts, src/client/replica/queries.ts, src/client/replica/repository-local.ts, tests/topic-materials.test.ts, tests/material-paging.test.ts.

- [ ] 분야·책 주제 상속·명시 거절·보관 주제·복합 종류·정렬과 페이지 경계 회귀 검사에서 실패 확인.
- [ ] 공통 자료 타입/주제 계산·정렬/페이지 순수 모델 구현. 서버 SQL 조회와 기기 materials 조회 연결.
- [ ] 고립된 PGlite DB와 순수 조회 결과를 비교하고 기존 자료 분할 검사를 통과.

### Task 2: 화면·마무리

Files: src/components/thought-map/topic-browser.tsx, src/components/thought-map/topic-manager.tsx, src/components/thought-map/panel.tsx, src/components/knowledge-panel.tsx, src/components/use-material-page.ts, src/app/globals.css, src/components/thought-map/help.tsx, e2e/topic-material-kind.spec.ts, playwright.topic-materials.config.ts.

- [ ] 모의 브라우저로 주제 필터·다섯 정렬·관리 영역 마지막 배치·높이·주제 재정렬 보존 실패 확인.
- [ ] 관리 영역을 분리하고 작은 접기 UI·위아래 이동·계정별 기기 설정 구현. 필터/정렬과 동일 높이 적용.
- [ ] 전체 관련 검사·타입 검사·PC/터치 화면 확인. 설명을 사용법에 정리.
- [ ] 새 검토자 한 명으로 전체 변경 검토 후 중요 지적 수정. 기존 승인된 GitHub/웹 배포 흐름으로 반영하고 공개 정적 파일 확인.
- [ ] 11/1 검수 목록과 운영 기록·사용자 요약을 갱신.
