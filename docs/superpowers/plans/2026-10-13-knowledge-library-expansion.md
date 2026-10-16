# Knowledge Library Expansion Implementation Plan

> For agentic workers: use superpowers:executing-plans. User explicitly requested continued implementation; retain native execution from this conversation.

**Goal:** 실제 종이책과 PDF를 읽고 검색하며 기록 사이를 연결하는 개인 지식서재.
**Architecture:** 기존 Next/Neon을 유지하고 PDF 원본과 대규모 페이지 색인을 로컬 처리한다. API는 소유자 신원을 검증하며 연결/메모는 온라인에 저장한다.
**Tech Stack:** Next 16, PostgreSQL, Python, SQLite FTS5, PDF extraction.
**Spec:** docs/superpowers/specs/2026-10-13-knowledge-library-expansion.md

## Global Constraints

원본 읽기 전용, E:\전자도서관만, 출처/수정 이력 보존, 무료 기본 동작, 미검증 자동 병합 금지, 기존 로그인/권한 유지. 415 완독과 현재 독서 4권을 실제 자료로 대조한다. 연간 원본 앱 수치 25.5권은 완료 날짜상 27회와 별도 표시.

## Review Focus

- 같은 기록/파일 재처리로 중복 도서·회차가 생기지 않는다.
- 파일 변경·외장하드 분리 시 오래된 인용을 현재 원문으로 가장하지 않는다.
- 로컬 파일/검색 엔드포인트가 임의 경로/다른 사용자 자료를 노출하지 않는다.
- PDF 페이지 순번과 인쇄 쪽수를 혼동하지 않는다.
- 연결 제안의 거절/수정 및 사용자 메모가 재실행으로 사라지지 않는다.

## Tasks

1. [x] 가독성과 실제 표지: globals.css, library-app.tsx. 장식 제거와 글꼴 개선. PC/모바일 시각 검수, 기존 UI 회귀 검사.
2. [x] 통계 변환: legacy-reading.ts, legacy-reading-store.ts, DB migration, migrate-reading.ts. 원본 세션 → 정식 회차 매핑 테스트 RED/GREEN; 재실행·충돌·소유자 격리; 실제 415/4 대조. annual reported metric과 계산된 회차 구분.
3. [x] PDF 로컬 색인: scripts/pdf_library.py 및 테스트. scan(root,index) → manifest; index job의 페이지별 진행·오류·재개. 임시 PDF로 페이지·변경·중복·손상 테스트. 전체 9,309개 등록.
4. [x] 목록/파일/검색 API와 화면: pdf-store.ts, /api/pdf, PdfLibraryPanel. UUID 파일 열기·안전한 byte range·정확한 페이지 발췌, 메모로 저장. 인용/권한/경로/원본변경 회귀 검사.
5. [x] 사유 연결과 연구 묶음: knowledge-store, knowledge API/UI. 설명 가능한 연결 제안과 승인/거절/관계 수정, 주장/근거/반론/생각 변화, 설교/논문 묶음과 출처 목록. DB/API 및 브라우저 검수.
6. [x] 실제 자료 검수·전체 테스트·빌드·독립 리뷰·사용 설명/잔여 처리 상태 기록.

검증 명령: Vitest 전체, Playwright 전체, Python unittest, Next build. 로컬 원본 파일은 삭제하거나 변경하지 않는다. 단계별 결과와 판단은 docs/implementation-ledger.md에 남긴다.

구현·검수 완료. 전체 PDF 본문 일괄 처리는 실행 중이며, 목록 등록과 처리/재개 기능의 완료를 전체 OCR 완료와 혼동하지 않는다. 상세 검증 및 잔여 범위는 implementation-ledger.md와 README.md 참고.
