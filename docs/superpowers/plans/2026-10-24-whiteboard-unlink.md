# Whiteboard Line Unlink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** PC·휴대폰에서 연결선을 선택해 실제 연결을 끊고 되돌릴 수 있게 한다.
**Architecture:** Canvas는 화면에 겹쳐 그려지는 관계 ID를 모두 보존하고 선택 도구를 표시한다. Panel은 기존 관계 수정·버전 확인·되돌리기·저장 명령을 재사용한다.
**Tech Stack:** React, TypeScript, SVG, Vitest, Playwright.
**Spec:** docs/superpowers/specs/2026-10-24-whiteboard-unlink-design.md

## Global Constraints

- 사용자 선택은 연결선 선택 → 끊기. 메모·묶음 구성·위치는 유지.
- 기존 E 단일 저장소와 별도 브랜치 사용. 실제 DB·기기 동기화 검수는 11/1까지 보류.
- 유료 AI와 실제 사용자 자료를 이용한 검사는 하지 않는다.

## Review Focus

- 접힌 묶음 때문에 여러 관계가 한 선으로 합쳐져도 ID를 잃지 않는다.
- 10% 확대에서도 터치 영역과 도구 상자의 크기가 안정적이다.
- 선 위에서 이동·빈 곳 선택·Escape가 뜻하지 않은 해제를 만들지 않는다.
- 실패·충돌이면 선을 유지하며 되돌리기는 최신 관계 버전을 사용한다.
- 메모 연결과 묶음 연결을 구분하고 다른 관계·구성을 보존한다.

### Task 1: 선 선택·관계 해제

Files: src/lib/whiteboard-lines.ts, src/components/whiteboard/canvas.tsx, src/components/whiteboard/panel.tsx, src/app/globals.css, tests/whiteboard-lines.test.ts, e2e/whiteboard.spec.ts.

- [x] 기존 모의 브라우저 fixture에서 ‘선 선택 → 끊기 → 실제 관계 rejected → 되돌리기 accepted’ 회귀 검사를 추가하고 실패 확인.
- [x] buildConnectionLines, hitPolygon, nearestConnectionLine 순수 함수와 검사를 작성. 가시 선에 실제 관계 ID 목록 또는 묶음 쌍을 보존.
- [x] SVG 터치·키보드 선택과 확대 영향 없는 도구 상자 구현. 기존 Panel 관계 수정 함수를 연결.
- [x] 묶음 연결 제거 함수를 목록·선 도구에서 공유하고 기존 되돌리기 재사용.
- [x] PC·터치, 실패 보존, 겹친 관계별 해제, 묶음 해제·되돌리기를 모의 브라우저로 검증.

### Task 2: 통합·배포·기록

- [x] 관련 단위 검사, 타입 검사, 모의 브라우저 검사와 필요한 빌드 검증.
- [x] 별도 코드 검토 한 번으로 잔여 결함 점검 후 필요한 수정.
- [x] 11/1 실제 동기화 검수 목록·사용법 업데이트.
- [x] 기존 승인된 웹 배포 경로로 반영하고 코드·정적 자산 확인. PC의 기존 PDF 서버·OCR 작업은 유지.
- [x] 변경과 확인 범위, OCR의 실제 최신 진행 상태를 보고.
