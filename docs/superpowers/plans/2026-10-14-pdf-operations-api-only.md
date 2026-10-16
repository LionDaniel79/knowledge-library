# PDF 운영 정비와 요청형 API 전환 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans, directly and sequentially as the user requested.

**Goal:** PDF 처리 중단을 복구하고 외장하드 중심으로 저장하며, 로컬 언어모델 실행을 폐지하고 명시적 API 도움만 남긴다.
**Architecture:** SQLite 온라인 백업 API로 외장하드에 일관된 색인 복사본을 생성·검증한 뒤 앱 설정을 전환한다. 대용량 해시는 서명과 경로를 확인하며 파일 단위로 재개한다. PDF 화면은 페이지별 처리 현황과 작업기 상태를 보여준다. 로컬 언어모델 어댑터·실행 진입점·UI는 종료하고 기존 요청형 API의 범위·예산·채택 절차를 유지한다.
**Tech Stack:** Python/SQLite, Node/Next.js/React, Vitest/PGlite/Playwright.
**Spec:** `docs/next-implementation-roadmap.md` 2·3단계와 사용자의 2026-10-14 추가 요청: 로컬 AI 삭제, API만 필요할 때 사용, 큰 작업은 외장하드 우선.

## Global Constraints

- E:/전자도서관만 처리하며 PDF 원본을 변경·삭제하지 않는다. 논문·간행물은 기본정보만 보존한다.
- 기존 메모·독서 기록·확정 관계·과거 결과를 보존한다. 기존 대기 작업을 유료 API로 자동 전환하지 않는다.
- 실제 서지 API·AI API 호출, 배포, push는 하지 않는다. OCR은 언어모델과 별도의 문자 추출 작업이다.
- C 색인은 검증된 E 복사본과 앱 전환 확인 전 변경·제거하지 않는다. 삭제 자동 심사 차단은 우회하지 않는다.
- 사용자 직접 삭제가 필요한 AI 폴더는 이미 안내했다. 다른 프로그램이나 .ollama 인증 파일은 건드리지 않는다.
- 기존 작업 브랜치 재사용, 순차 구현, 마지막 별도 검토. 승인받은 실행 방향을 다시 묻지 않는다.

## Review Focus

- WAL에만 있는 자료도 외장하드 복사본에 포함되어야 하며 기존 대상 경로를 덮어쓰지 않아야 한다.
- 진행률이 OCR 미검수·빈 결과·대기를 구분하고 오래된 작업기 상태를 실행 중으로 오인하지 않아야 한다.
- 중복 판단은 실제 파일 해시와 현재 파일 서명이 일치할 때만 제공하고 원본을 자동 병합·삭제하지 않는다.
- 폐지한 로컬 모델·작업기 호출은 네트워크·DB 변경 전에 차단되어야 한다.
- 일반 저장·검색·지도 화면 열기가 AI API 요청을 만들지 않아야 한다.

### Task 1: 검증된 외장하드 색인 복사와 OCR 재개

**Files:** `scripts/pdf_maintenance.py`, `scripts/test_pdf_maintenance.py`, local `.env.local` (untracked).
**Interfaces:** `copy_index(source, destination)` refuses existing target, copies a consistent SQLite snapshot, verifies quick_check plus table counts, adds a covering `(document_id,method)` page index. Source remains untouched. CLI `copy --index --destination`.
- [x] Write tests for WAL inclusion, existing target rejection, source unchanged and queryable copied full-text index; observe RED.
- [x] Implement and pass Python tests; start actual snapshot copy to `E:/지식서재 작업/색인/pdf-library.sqlite`.
- [x] Verify actual copy before switching only LIBRARY_PDF_INDEX. Integrity/table-count checks passed at 11:59 KST; app index is now on E.
- [x] Copy derived PDF covers/cache and large private backups to external working storage, preserving originals. Verify the 9,219 cover files by names/sizes and the private backup by SHA-256.
- [x] Resume OCR on E once copy verification passes; no duplicate worker. The continuation started OCR at 12:00 KST; advancing saved progress confirmed at 15:29 KST.
- [x] Commit implementation and record verification.

### Task 2: 로컬 언어모델 실행 폐지

**Files:** `src/local/ai/ollama.ts`, `src/local/ai/model-manifest.ts`, relevant scripts, `src/app/api/thought-worker/route.ts`, thought-map components, package/env examples, tests/e2e/docs.
**Interfaces:** legacy model entry points throw a clear retired error before model fetch; old worker route returns 410 to all callers before authentication or DB side effects and returns no private data; old CLI commands removed. Existing assist API uses explicit preview→request→result→adopt, disabled without configured key/budget. Lightweight PC API relay does not load local models.
- [x] Reproduce local adapter acceptance and legacy UI display; add retirement regression tests RED.
- [x] Retire runtime/manifest and CLI, remove local analysis controls, update historical result labels without modifying stored results. Keep pure evaluation/history helpers needed by API/manual flows.
- [x] Verify no automatic API fallback, existing API approval/budget tests, browser absence of local controls; full suite and commit. Physical model files remain for the user's later manual deletion.

### Task 3: 해시 보완·오류 및 중복 감사

**Files:** maintenance script/tests and private external reports.
**Interfaces:** `hash_documents(index, limit=0)` streams SHA-256 only for unresolved files within configured root, checks stat/signature before and after, commits individually, records safe progress. `audit(index)` returns exact hash groups and unresolved/error/review inventory without modifying books/files.
- [x] Tests for byte-identical files, same name/different bytes, changed files, path escape, resumability RED→GREEN.
- [x] Run real missing hashes on E and confirm advancing progress after the verified copy becomes active. Hashing is running; corpus completion remains a background operation.
- [x] Examine seven error file headers and visually inspect all 37 mixed materials. All 37 are journal supplements and stay metadata-only; save decisions separately until the verified index is active. Do not infer actual editions from filenames.
- [x] Save dated private report, verify stored-hash original file signatures unchanged, commit code. The continuation will produce a new all-file audit after migration.

### Task 4: PDF 진행 현황 화면

**Files:** `scripts/pdf_ocr.py`, Python tests, `src/server/pdf-index.ts`, `src/components/pdf-library-panel.tsx`, related tests/e2e.
**Interfaces:** OCR writes versioned atomic status file beside index (running/paused/completed/failed, counts, updatedAt, safe reason). Summary includes exact page methods and current signature-bound file/hash totals; no AI calls. UI distinguishes native text, OCR unverified, empty/error/pending and stale/offline state.
- [x] Test durable low-space status, resume, stale heartbeat, excluded material counts and small-screen display RED.
- [x] Implement modest progress block with optional details, no raw paths/secrets. Preserve existing PDF search and citation behavior.
- [x] Full tests/typecheck/build, fresh whole-change review and fixes. Keep branch local. Final results: 138 unit/integration + 14 Python + 38 browser tests passed; all 3 Important review findings fixed.
- [x] Verify actual external-index read speed and advancing OCR/hash progress after migration. Initial summary: 3,101ms; under concurrent OCR/hash load at 15:29 KST: 71,383ms. This establishes correct data access but leaves a significant response-time issue to investigate separately.

## Actual operation checkpoint — 2026-10-14 09:52 KST

The 11,001,630,720-byte copy exists on E, but verification is still running and the verified marker does not yet exist. The source C index remains active and intact. Copy PID 26748 is reading data; hidden continuation PID 11176 is waiting for that exact copy to exit. The continuation requires the verified marker and matching table counts before applying the 37 scope decisions, switching the app index, checking its summary, auditing originals and starting OCR/hash with temporary files and logs on E. It stops on a failed check.

Private continuation status: `E:/지식서재 작업/검수/migration-status-20261014.json` (created after the copy succeeds). Logs: `E:/지식서재 작업/logs/migration-continuation-20261014*.log`. Check these and the `.ocr-status.json` / `.hash-status.json` files beside the index before claiming migration or worker resumption complete. This is one running continuation, not a recurring schedule or a reboot startup task.

## Verified operation follow-up — 2026-10-14 15:29 KST

Copy verification succeeded after 11,586.9 seconds: 9,309 documents, 1,838,220 stored page rows (including historical excluded rows) and 38,033 OCR audit rows matched the source snapshot. All 37 journal decisions were applied as metadata-only. The post-copy audit found no missing/changed/out-of-root originals. `.env.local` points to E. OCR PID 27224 and hash PID 2828 started at 12:00 and their recent durable counts are advancing with zero new job errors.

At 15:29:25, worker checkpoints imply 1,181,568 searchable book pages (80.08%), 54,842 OCR pages processed of 346,143, and 8,908 hashes stored of 9,309. These are ongoing snapshots, not corpus completion. The direct app summary independently confirms both jobs running and the same approximate progress; aggregation is not an atomic all-fields snapshot while writers run. Local model files still occupy 10.54 GiB; no Ollama process is running. User requested manual deletion instructions; do not retry the blocked deletion.

Follow-up concern: summary aggregation under concurrent HDD load took 71.4 seconds. Do not describe status refresh as fast; investigate/cap expensive refresh work before treating external-drive performance as resolved. No new API calls or cloud changes were made.
