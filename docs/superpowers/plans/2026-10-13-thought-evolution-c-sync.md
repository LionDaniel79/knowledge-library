# Local Analysis Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기록 저장이나 분석 요청을 PC가 처리하고 웹앱에서 대기 상태와 검토 결과를 확인하게 한다.

**Architecture:** 온라인 작업 대기열과 로컬 실행기를 분리한다. PC는 외부로 요청해 작업을 받고, 서버는 작업 임대·소유자·원문 버전을 검증한 결과만 저장한다. 현재 로컬 앱에서도 동일 작업 계약을 사용하며 원격 배포는 별도 검수한다.

**Tech Stack:** 기존 Node/pg/Next/Zod, A단계 LocalAi, B단계 ThoughtIndex/분석·검증·저장 함수, Vitest/PGlite/Playwright.

**Spec:** `docs/superpowers/specs/2026-10-13-thought-evolution-design.md`; 선행 A/B 상세 계획.

## Global Constraints

- PC가 꺼져 있으면 새 분석은 대기한다. 기존 결과는 계속 조회할 수 있다.
- 동시에 분석 1건만 실행한다. 사용자가 누른 분석을 기존 PDF 전체 분석보다 우선한다.
- PC가 외부로 연결해 작업을 가져오는 방식이다. PC의 추론 포트를 인터넷에 열지 않는다.
- 원문·벡터·모델은 로컬, 소유자 메모·작업 상태·후보·확정 결과는 온라인에 저장한다.
- 모든 기능은 A/B 계약과 상위 계획의 소유자·보존·무료 우선 조건을 적용한다.

## Review Focus

- 재시작한 작업과 이전 실행 결과의 경쟁: lease token과 소스 버전 불일치 거절. C1/C2.
- 앱 저장 성공 뒤 분석 대기열 실패: 저장을 실패로 바꾸지 않고 재수집. C1.
- 모델 불가·외장하드 없음·PC 절전: 상태별로 구분하고 메모 분석까지 막지 않음. C2/C4.
- 다른 소유자·해지 기기·재전송 결과: 인증과 멱등 결과 검증. C3.
- 유휴 상태의 잦은 DB 조회로 무료 한도 소모: 대기 간격·조회량 측정. C2.

### Task C1: 버전별 작업 대기열

**Files:** Create `db/008_thought_jobs.sql`, `src/server/thought-job-store.ts`, `src/lib/thought-map/jobs.ts`, `tests/thought-jobs.test.ts`; Modify `scripts/migrate.ts`, `src/server/library-store.ts` note transaction, B1 event/topic edits, migration test lists.

**Interfaces:** `AnalysisJob {id,ownerId,kind:'index'|'compare'|'pdf_context',sourceId,sourceVersion,status:'queued'|'running'|'completed'|'failed'|'superseded',attempts,leaseToken:string|null,leaseExpiresAt:string|null}`; IDs/sourceVersion are strings. `createThoughtJobStore(db)` exposes `enqueue(tx:Executor,owner:string,input:JobInput):Promise<string>`, `claim(owner:string,workerId:string,now:Date):Promise<AnalysisJob|null>`, `renew(owner:string,id:string,leaseToken:string,now:Date):Promise<boolean>`, `finish(owner:string,id:string,leaseToken:string,result:JobResult,now:Date):Promise<void>`. Define `JobInput {kind:AnalysisJob['kind'],sourceId:string,sourceVersion:string,modelDigest:string,promptVersion:string,retrievalVersion:string,priority:0|1}` and `JobResult {candidateInputs:CandidateInput[],indexStatus:'ready'|'partial'|'unavailable'}`; C3 transports these unchanged.

AnalysisJob extends JobInput with id/ownerId/status/lease fields, numeric attempts and string sourceHash. sourceVersion is a canonical hash of note version, event version and topic-membership revision; final context signatures are separately pinned on candidates. Model/prompt/retrieval digests are part of job identity, but never part of rejected-pair identity.

- [ ] **1. Write failing tests:** retry same source/config creates one job; two claims obtain at most one same job; expired lease permits retry but old lease cannot finish; original note edit supersedes old job and candidate; same-note version edits do not create self-to-self changes; artificial enqueue outage leaves saved note intact and reconciler later adds the missing job.
- [ ] **2. RED:** `npm test -- tests/thought-jobs.test.ts`.
- [ ] **3. Implement** owner-scoped jobs with unique fingerprint, `FOR UPDATE SKIP LOCKED`, lease120s, renew30s, max3 attempts and retry delay30s then60s. Within the note mutation use a savepoint for noncritical enqueue, so enqueue failure cannot roll back an otherwise valid note; reconciliation enumerates latest note/event revisions. Acquire locks in stable note-ID order before candidate finish. Results and completed job state commit in one transaction, exact repeated completion is idempotent, different result for a completed job is409. Rejected pair suppression is independent of job/model fingerprint.

  `waiting_for_pc` is a user-visible state derived from queued jobs and worker heartbeat, not an extra persisted state that prevents claiming. Explicitly test this projection. If the main transaction fails for unrelated DB reasons, note save remains failed rather than reporting a false success.
- [ ] **4. GREEN:** PGlite tests; real Neon rollback verifies claims, lease transitions and no cross-owner access. Extend export to include non-secret job state but never lease tokens or device credentials.
- [ ] **5. Commit** explicit C1 paths: `feat: queue versioned thought analysis jobs`.

### Task C2: 로컬 작업기와 사용자 상태

**Files:** Create `scripts/thought-worker.ts`, `src/local/thought-map/worker.ts`, `src/components/thought-map/analysis-status.tsx`, `tests/thought-worker.test.ts`, `e2e/thought-worker.spec.ts`; Modify `package.json`, B2 panel/API, `docs/local-ai-operations.md`.

**Interfaces:** `runThoughtWorker(transport:WorkerTransport,ai:LocalAi,index:ThoughtIndex,signal:AbortSignal):Promise<void>`; `WorkerTransport {claim():Promise<AnalysisJob|null>,renew(job):Promise<boolean>,getSources(job):Promise<WorkerSources>,finish(job,result:JobResult):Promise<void>,fail(job,code:string):Promise<void>,heartbeat(nextPollSeconds:number):Promise<void>}`. `WorkerSources {notes:AnalysisRecord[],context:ContextExcerpt[],topics:Topic[],memberships:Membership[],feedback:Feedback[]}`. Initially a trusted local adapter uses existing app-role DB access with a verified configured owner; hosted mode uses C3, never the migration owner.

- [ ] **1. Write failing fake-clock tests:** one active job, manual priority first, wake after lease expiry, aborted request unloads model, no retry storm, unchanged source digest avoids embedding, heartbeat expires after actual declared next-poll deadline. Browser verifies waiting/running/failed/retry/completed, stale candidates and retained prior results.
- [ ] **2. RED:** `npm test -- tests/thought-worker.test.ts`; `npx playwright test e2e/thought-worker.spec.ts`.
- [ ] **3. Implement** short indexing batches with checkpoints, low-priority initial metadata index followed by notes; stop/preempt batches between sources for manual requests. Active poll5s; idle after1min backs off15s, then60s after5min. Store worker lastSeen+expectedNextPoll; UI says `PC 연결 확인 중` only after deadline+30s, not based on a fixed heartbeat that contradicts idle polling. UI polls5s only for pending work while visible and stops on completion/background. Show queue length, last result time and last successful heartbeat without promising immediate completion. Reconcile missed version jobs on start. Model unavailable is explicit; no silent cloud/lexical fallback labeled AI. Cache and credentials live outside Git. Start/stop instructions are explicit; no automatic boot registration yet.
- [ ] **4. GREEN and soak:** fake-clock tests plus manual stop/start during a private sample; resume once with no duplicate candidate. Measure idle DB request count and active compute time before describing operation as free; no paid upgrade. Published UI may still work with PC off, but local-only localhost app itself requires its server to be running.
- [ ] **5. Commit** explicit C2 paths: `feat: run resumable local thought analysis`.

### Task C3: 기기 인증과 원격 작업 전달

**Files:** Create `db/009_analysis_devices.sql`, `src/server/thought-device-auth.ts`, `src/app/api/thought-worker/route.ts`, `src/app/api/thought-devices/route.ts`, `src/local/thought-map/remote-transport.ts`, `tests/thought-device-auth.test.ts`, `e2e/thought-devices.spec.ts`; Modify migrate/grants and operations guide.

**Interfaces:** owner-cookie endpoint creates/revokes named devices with256-bit random secret returned once, DB stores only SHA-256 hash, owner, expiry90days, revokedAt, lastSeen. `requireWorker(request:Request):Promise<{ownerId:string,deviceId:string}>`; bearer worker endpoint discriminated ops `claim|renew|sources|finish|fail|heartbeat` implements WorkerTransport. Revocation checked on every request. Local worker token comes from ignored per-user config, never console output/browser storage/URL.

- [ ] **1. Write failures:** anonymous/expired/revoked token→401; device belonging to owner A requesting owner B/source B/job B→404; mutated lease or unsolicited candidate→409; cookie write without allowed origin→403; oversized request→413. Raw token never appears in snapshots/export/logs and device cannot accept/reject candidates or modify books.
- [ ] **2. RED:** device unit/route tests and device UI test.
- [ ] **3. Implement** allowed-owner cookie + CSRF check for device management and scoped bearer auth for worker only; server assigns owner, sources constrained to job and stored owner records. `finish` revalidates quote spans/versions server-side and runs B3 candidate checks. Worker origin HTTPS only outside loopback, redirects refused, no inbound PC port. Add idempotent revoke and allow user to replace a token without losing jobs. Fixed payload sizes: metadata requests≤20KB; job source/result≤512KB; rate-limit device token attempts using persistent bounded state, avoid process-memory-only limits in serverless deployment.
- [ ] **4. GREEN:** test the full request path with local test server/two devices and owner isolation. Existing Google sign-in/proxy callback regressions pass. Actual Vercel/mobile test requires deployment separately; mock transport success is never reported as hosted verification.
- [ ] **5. Commit** explicit C3 paths: `feat: authorize outbound personal analysis workers`.

### Task C4: PDF 근거 맥락과 최종 검수

**Files:** Create `src/local/thought-map/pdf-context.ts`, `tests/thought-pdf-context.test.ts`; Modify C2 worker, B3 source indexing, `scripts/verify-live.ts`, README and implementation ledger.

**Interfaces:** `findPdfContext(index:ThoughtIndex,query:AnalysisRecord,bookIds:string[],limit:number):Promise<ContextExcerpt[]>`. Consumes existing PDF SQLite index read-only, stores derived vectors separately and returns page/signature/coverage; do not mutate the active PDF writer's database.

- [ ] **1. Write failures:** missing external drive permits note-only comparison but blocks new verified PDF citations; changed file invalidates cached vectors/links; OCR-empty pages cannot produce text claims; metadata-only matches cannot fabricate page quotes; one large PDF cannot take every context slot.
- [ ] **2. RED:** `npm test -- tests/thought-pdf-context.test.ts`.
- [ ] **3. Implement** source routing from relevant book/topic metadata to already-extracted pages; index selected chapters/pages on demand with page boundaries and exact offsets. All-PDF semantic indexing is an explicit later batch, not automatically kicked off. Reuse current citation/source-signature checking. PC verifies local PDF context; server stores excerpt/signature as context evidence with `locally verified` provenance rather than claiming the hosted server opened the disk.
- [ ] **4. GREEN and release evidence:** targeted tests; `npm test`, `npm run typecheck`, `npm run test:e2e`, `npm run build`, Python existing tests and `npm run verify:live`. Review desktop/mobile screenshot, unknown date, no-AI, inactive-PC, recovered lease, changed source, rejected-pair rerun, feedback rollback, and v5 export. One fresh reviewer reviews the completed branch as required by the chosen execution skill; fix substantiated findings in one batch. No unrelated test expansion after checks pass.
- [ ] **5. Commit** explicit C4 paths: `feat: connect verified PDF context to thought evolution`; record measured latency/quality, remaining unindexed data and hosted-verification status. Keep the existing feature branch and private data; do not push or deploy without the relevant user scope.
