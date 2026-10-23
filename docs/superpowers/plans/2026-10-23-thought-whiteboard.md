# Thought Whiteboard Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for direct sequential implementation.

**Goal:** 검색한 실제 메모를 포스트잇으로 묶고 연결하는 화이트보드.
**Architecture:** 순수 보드 모델, React/SVG 화면, 기존 지식 연결 저장 재사용, 전용 보드 배치 행과 기기 변경 대기.
**Tech Stack:** 기존 Next/React/TypeScript/Zod/Postgres/IndexedDB. 새 의존성 없음.
**Spec:** docs/superpowers/specs/2026-10-23-thought-whiteboard-design.md

## Global Constraints

- 사용자가 지정한 9개 기능, 원본 메모/주제 보존, 임의 AI/유료 호출 금지.
- 실 동기화 검사와 운영 DB 구조 적용은 2026-11-01까지 보류.
- 필터의 보이지 않는 메모와 연결을 삭제하지 않고, 취소/단순 클릭은 연결하지 않음.
- 좌표·크기·참조 검증, 소유권·멱등 요청·버전 충돌·이력 보존.

## Tasks

- [x] 1. 순수 보드 스키마·필터·배치·근접/겹침·그룹·연결 규칙과 회귀 검사.
- [x] 2. 보드 저장소/API·기기 조회/변경 대기·DB 마이그레이션 및 백업 준비. 운영 적용은 보류.
- [x] 3. 검색형 복수 선택 도구 줄, 카드·드래그·그룹·연결·저장·오류/되돌리기 UI.
- [x] 4. PC/휴대폰 화면과 실제 메모 연결 명령을 격리 브라우저로 검증, 빌드·독립 검토·수정.
- [x] 5. 변경 반영 준비 및 11월 1일 검수 문서/예약. 서버·OCR 운영 상태와 관계없는 작업은 유지.

코드와 격리 검증은 완료했다. 운영 DB 구조 적용·실제 기기 간 동기화 검수는 2026-11-01 오전 10시 예약 작업에서 진행하며, 지금 완료된 것으로 표시하지 않는다. 검증 근거는 `docs/operations/whiteboard-verification-2026-10-24.md`에 기록한다.

## Review Focus

- 제목만이 아닌 메모 전체 본문 검색, 미분류와 복수 주제의 같은 원본, 휴지통/제외 도서 처리.
- 주제 선택 변경/필터 변경 때 기존 좌표가 손실되지 않고 그룹 이동이 누락 메모를 잃지 않는가.
- 빠른 연속 드래그 저장 순서·실패한 실제 연결을 성공으로 표시하지 않음.
- 터치 스크롤/드래그 취소/클릭을 구분, 헤더·연결 버튼으로 같은 기능 접근.
- 메모 관계와 임의 묶음 관계를 혼동하거나 거짓 생각 변화로 기록하지 않음.
