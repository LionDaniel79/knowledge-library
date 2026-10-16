# Human-owned Knowledge Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. 사용자가 선택한 직접 순차 구현을 유지한다. Steps use checkbox (`- [ ]`) syntax for tracking. 계획 승인 후 2026-10-14까지 T1~T6 구현, T7 표본 반영·검수 도구 구현을 진행했다. 사람 검수·API 실측·전체 자료 확대는 조건 대기다. 아래 체크리스트는 최초 계획이며, 실제 결과는 [구현·검수 결과](../../human-owned-library-acceptance.md)와 커밋 기록을 따른다.

**Goal:** 지금 개발 중 기존 자료를 AI로 정비하고, 완성 후에는 사용자가 직접 기록·분류·연결·판단하는 지식서재를 만든다.

**Architecture:** 기존 Next/Neon 서재에 원자료·검색용 보조 정보·개인 기록의 경계를 둔다. 개발용 정비 도구로 보조 색인을 만들며 앱 시작과 분리한다. 일상 기능은 AI 없이 작동하고, 선택한 자료에 대한 명시적 GPT 보조 요청만 PC 작업기를 통해 처리한다.

**Tech Stack:** 현재 잠금된 Next/React/TypeScript, pg/Neon, Zod, Vitest/PGlite, Playwright, Node SQLite/PDF 도구. GPT 연결은 PC의 Node fetch와 Responses API를 사용한다. 기존 로컬 검색·인용 검증기를 재사용하며 모델 학습 프레임워크를 추가하지 않는다.

**Spec:** [내가 쓰고 판단하는 지식서재](../specs/2026-10-13-human-owned-library-design.md).

## Global Constraints

- AI를 많이 쓰는 시점은 지금 진행하는 개발과 기존 자료 정비 과정이다. 앱을 처음 실행하는 시점이 아니다.
- 저장·수정·페이지 진입·앱 시작·작업기 연결로 GPT 호출이나 생성 분석 작업을 등록하지 않는다.
- AI는 개인 기록과 판단 영역의 글을 자동 작성·수정하지 않는다. 채택한 제안도 원래 작성 출처와 확인 이력을 유지한다.
- 원본 PDF와 sources/는 읽기 전용이다. PDF 대상은 E:\전자도서관뿐이다. 개인 자료·키·정비 결과는 Git에 넣지 않는다.
- 공식 KDC, AI의 검색용 분류, 개인 주제·태그, 책장은 구분한다. 출처·판본이 확인되지 않은 값을 공식 서지로 확정하지 않는다.
- coverage는 metadata / toc / partial / full을 유지한다. 날짜·발화 주체를 자동 확정하지 않는다.
- API 키·한도 없이는 호출하지 않는다. 현재 예산은 미설정이다. Codex 개발 지원과 별도 API 청구를 구분한다.
- 운영 GPT 요청은 동시 1개다. PC가 꺼지면 대기하고 온라인 자료의 저장·검색·수동 지도는 계속 작동한다.
- 앱 최초 실행 정비, 자동 감상·설교·논문 작성, 로컬 생성 모델 강화학습, ChatGPT 브라우저 자동화는 범위에 없다.
- 모든 변경은 소유자·원문 버전·수정 이력을 검증한다. 기존 승인 관계·독서 기록은 유지한다.

## Review Focus

1. 전환 직전 시작한 자동 분석의 늦은 결과: 정책 변경과 임대 검증으로 반영을 막는다. T1/T6.
2. 가져온 인용·미확인 날짜·기존 태그의 출처 오인: 원문과 불확실성을 보존한다. T2/T3/T4.
3. API 송신 직후 연결 중단·두 PC의 중복 처리: 비용 예약을 유지하고 자동 재호출·중복 저장을 막는다. T5/T6.
4. 대량 정비 중 사용자가 자료를 수정: 오래된 결과를 적용하지 않고 후속 수정을 롤백하지 않는다. T2/T3.
5. 많은 종교 자료에 다른 분야·미분류·반론이 묻힘: 교차 분야 검색과 개인 기록 검색 품질을 따로 검수한다. T4/T7.

## 순서와 파일 경계

T1 자동 분석 중단 → T2 보조 정보와 출처 저장 → T3 개발용 정비 → T4 직접 기록·검색 화면 → T5 제한된 API → T6 명시적 보조 요청 → T7 자료 확대·검수.

T3는 Codex/규칙/서지 제공자 결과로 먼저 진행할 수 있다. 유료 대량 처리는 T5 이후 한도가 설정된 경우에만 한다. T4까지는 API 없이 사용할 수 있다.

| 경계 | 책임 |
|---|---|
| src/lib/library-ai-policy.ts, src/server/library-ai-policy.ts | 기본 수동 운영, 정책 버전, 호출 조건 |
| src/lib/curation.ts, src/server/curation-store.ts | 정비 스키마, 출처, 보조 정보, 되돌리기 |
| src/local/curation/, scripts/curate-library.ts | 개발 중 현황 조사, 표본, 검증, 반영 |
| src/server/library-search.ts, 기존 기록·지도 화면 | 층별 검색과 수동 판단 |
| src/lib/assist.ts, src/local/ai/openai.ts, src/server/ai-usage-store.ts | 제한된 요청·응답, GPT 호출, 비용 예약·정산 |
| src/server/assist-store.ts, src/local/assist/, scripts/assist-worker.ts | 명시적 요청의 PC 처리와 동기화 |

DB는 기존 src/server/library-store.ts의 Database/Executor를 사용한다. 소유자는 로그인 또는 등록 기기에서 확정한다. 기존 모듈 전체를 다시 쓰지 않고 새 책임만 분리한다.

## Task 1: 저장과 자동 분석 분리

**Create:** db/010_library_ai_policy.sql, src/lib/library-ai-policy.ts, src/server/library-ai-policy.ts, tests/library-ai-policy.test.ts.

**Modify:** scripts/migrate.ts, src/server/library-store.ts, src/server/thought-map-store.ts, src/server/thought-job-store.ts, src/server/auto-connect.ts, src/app/api/library/route.ts, src/app/api/pdf/citation/route.ts, src/app/api/thought-jobs/route.ts, src/app/api/thought-worker/route.ts, scripts/thought-worker.ts, scripts/analyze-thoughts.ts, tests/thought-jobs.test.ts, tests/thought-worker.test.ts, tests/store.test.ts.

**Interfaces:**
- LibraryAiPolicy: runtimeMode='manual_only', requestsEnabled=false, developmentLimitUsd/runtimeMonthlyLimitUsd/requestLimitUsd=null, version. 금액은 십진 문자열로 저장하고 부동소수 누적을 피한다.
- `getLibraryAiPolicy(db: Executor, owner: string): Promise<LibraryAiPolicy>`: 설정 행이 없어도 안전한 기본값을 반환한다.
- `retireAutomaticJobs(tx: Executor, owner: string): Promise<number>`: 미완료 기존 자동 비교를 superseded로 보존하고 정책 버전을 바꾼다. 확정 후보는 남긴다.

- [ ] **실패 테스트:** tests/library-ai-policy.test.ts에서 신규 저장·수정·날짜/발화 주체 변경·화면 조회·작업기 접속/reconcile 이후 비교 작업 증가 0을 검증한다. 실행 중 기존 작업의 늦은 finish도 새 후보 0, 기존 accepted 후보 불변이어야 한다.
- [ ] **실패 확인:** `npm test -- tests/library-ai-policy.test.ts tests/thought-jobs.test.ts tests/thought-worker.test.ts tests/store.test.ts`. 현재 자동 enqueue를 잡는 실패를 확인한다.
- [ ] **정책 구현:** 기본값·마이그레이션·앱 역할 권한을 추가한다. 기존 생성 작업의 claim/finish를 서버에서도 막고 시작 시 전체 기록을 reconcile하지 않는다. 기존 CLI의 합성 시험은 유지할 수 있지만 개인 자료 자동 분석은 중단한다.
- [ ] **저장 분리:** 저장 후 enqueueSavedThought와 suggestForSavedNote의 암묵적 호출을 없앤다. 관련 자료는 T4의 읽기 검색으로 옮긴다. 저장만으로 관계 후보를 영구 생성하지 않으며 수동 관계·기존 이력은 유지한다.
- [ ] **통과 확인:** 같은 테스트와 `npm run typecheck`. 생성 AI가 필요 없는 PDF 추출·독립적인 색인 갱신까지 중단하지 않는다.
- [ ] **커밋:** 이 작업의 변경만 확인하고 `feat: make library operations human driven`. 실DB 적용 전에 현재 자료·이력 백업을 확인한다.

## Task 2: 보조 정보·작성 경위·되돌리기

**Create:** db/011_library_curation.sql, src/lib/curation.ts, src/server/curation-store.ts, src/server/curation-export.ts, tests/curation-store.test.ts, tests/curation-export.test.ts.

**Modify:** scripts/migrate.ts, src/server/library-store.ts, src/app/api/export/route.ts, src/lib/domain.ts, tests/store.test.ts.

**Interfaces:**
- SourceRef: kind='book'|'note'|'pdf_chunk', id, version. PDF 버전에는 파일/추출문 hash를 반영한다.
- 이 태스크의 SourceRef는 기존 분석 타입과 이름이 충돌하지 않도록 curation 모듈에서 가져온다. 보조 항목 origin의 codex/api는 필드 출처상 ai로 묶되 실제 생성자는 별도 보존한다.
- CurationItem: id/runId/source, kind='tag'|'topic'|'alias'|'description'|'bibliography'|'duplicate_candidate', proposedValue, evidence, coverage, origin='rule'|'codex'|'api'|'provider', generator/version, state, reviewer. Zod로 검증하고 evidence는 원문 범위 또는 실제 서지 응답 참조다.
- `createCurationStore(db: Database)`는 `apply(owner: string, runId: string, items: CurationItem[]): Promise<{ applied: number; stale: number; invalid: number }>`와 `rollback(owner: string, runId: string): Promise<{ reverted: number; conflicted: number }>`를 제공한다.
- `exportCuration(db: Executor, owner: string): Promise<CurationExport>`: 실행·항목·필드 출처·판단 이력을 포함한다. 비밀키·절대 경로·기기 토큰은 제외한다.

- [ ] **실패 테스트:** 다른 owner ID, 오래된 원문 버전, AI가 만든 ISBN, 수동 수정 필드, 인용 혼재 메모를 입력한다. 무단 변경 0, 개인 본문/날짜/독서 이력 불변, AI 제안 채택 후에도 AI 출처 유지, 적용 이후 사람의 수정은 rollback 충돌로 보존되는지 검증한다.
- [ ] **실패 확인:** `npm test -- tests/curation-store.test.ts tests/curation-export.test.ts`.
- [ ] **저장 구현:** library_curation_runs/items/field_origins와 소유자 복합 제약을 추가한다. AI 결과는 보조 층에만 저장한다. 정확히 같은 판본의 검증된 서지만 누락·수동 미수정 필드에 별도 감사 이력과 함께 채울 수 있다. 판본 불명은 후보로 남긴다.
- [ ] **출처/내보내기 구현:** revisions/sourceData로 확실히 확인할 수 있는 경위만 옮기고 불명은 legacy_unknown으로 둔다. 작성자와 확인자는 분리한다. export schemaVersion 5를 6으로 확장하며 기존 필드를 유지한다. JSON/Markdown은 개인 기록·보조 정보·판단 이력을 구분한다. 모든 보조 항목을 도서 목록 응답에 넣지 않고 T4에서 나눠 조회한다.
- [ ] **통과 확인:** 같은 테스트와 `npm test -- tests/store.test.ts`. 재적용은 중복을 만들지 않고 사용자가 숨긴 보조 태그를 복구하지 않는다.
- [ ] **커밋:** `feat: preserve authorship and reversible library curation`.

## Task 3: 지금 개발 중 사용할 자료 정비 도구

**추가 우선순위:** 전체 PDF 범위 분류 → 논문·간행물 metadata_only 강제(직접 호출·검색·문맥·정비 모두) → 일반 도서의 재개 가능한 색인/OCR → 전체 목록의 출처 기반 서지·목차·소개 보강. 책·논문 혼합 폴더는 확인 전 보류하며 강해집·성경 주석서는 포함. 기존 원문·추출문 백업을 먼저 만든다. 디스크 여유를 검사하고 재시작 시 이미 끝낸 페이지를 다시 처리하지 않는다. 비용이 드는 GPT 호출은 키와 예산 설정 전 실행하지 않는다.


**Create:** src/local/curation/inventory.ts, src/local/curation/validate.ts, scripts/curate-library.ts, tests/curation-tool.test.ts, docs/development-library-curation.md.

**Modify:** scripts/audit-catalog.ts, scripts/enrich-catalog.ts, scripts/verify-library-categories.ts, src/server/catalog-provider.ts, package.json, .gitignore.

**Interfaces:**
- `buildCurationInventory(input: { owner: string; pdfRoot: string; outputDir: string }): Promise<InventoryManifest>`: ID/버전/추출 범위/누락/출처 집계와 snapshot hash. 필요한 원문은 비공개 파일로 별도 저장한다.
- `validateCurationItems(items: unknown, inventory: InventoryManifest): CurationValidation`: T2 스키마, 근거, 원문 버전을 확인해 valid와 rejected 이유를 반환한다.
- CLI `scripts/curate-library.ts <inventory|sample|validate|apply|rollback|seal> --run <id>`. apply는 검증된 파일에서 최대 100건, 기본 dry-run, 쓰기는 명시적 --apply에만 허용한다. 앱 시작·빌드에서 호출하지 않는다.

- [ ] **실패 테스트:** 임시 합성 자료로 허용 폴더 밖 파일, 같은 hash, 다른 번역판, 빈 OCR, 인용 혼재, 원문 변경을 만든다. 원본 쓰기/삭제 0, 판본 자동 병합 0, 중복 없는 표본 60건, dry-run 변경 0, 종료된 실행의 재적용 0을 검증한다.
- [ ] **실패 확인:** `npm test -- tests/curation-tool.test.ts tests/catalog-provider.test.ts`.
- [ ] **현황/표본 구현:** 허용 경로 E:\전자도서관을 정규화해 검증한다. 현재 건수를 다시 세고 서지/PDF 30건＋메모 20건＋모호 사례 10건을 겹치지 않게 선택한다. 원문 없는 종이책은 metadata, 목차만 있으면 toc다.
- [ ] **정비 흐름 구현:** Codex가 필요한 표본을 확인해 주제·동의어·태그 후보를 비공개 JSON에 작성한다. 공식 KDC와 AI 분류를 구별한다. apply/rollback/seal은 T2 저장소를 사용하며 공식 키가 없으면 검증 전으로 남긴다. Codex 결과도 동일한 검증기를 거친다. 앱에 Codex 자동 호출 기능을 넣는다는 뜻은 아니다.
- [ ] **기존 정비 보호:** enrich-catalog의 메모 태그 쓰기를 보조 층으로 돌린다. 개인 본문을 AI로 다시 쓰는 기능은 만들지 않는다. 읽지 않은 본문 요약·자동 파일 삭제를 하지 않는다. 준비·재개·복구 절차를 문서화한다.
- [ ] **통과 확인:** 위 테스트와 합성 자료의 inventory→sample→validate→apply→rollback. 복구 후 원기록 hash가 같아야 한다. 실제 자료의 조사/dry-run/소량 검증은 여기서 시작할 수 있고 대량 적용은 T7 검수 후 한다.
- [ ] **커밋:** `feat: add development-only library curation tools`. 개인 자료가 포함되지 않았는지 확인한다.

## Task 4: 직접 쓰고 찾고 연결하는 화면

**추가 표시 원칙:** 출처·수집일·판본·검증 상세는 ‘근거 보기’ 안에 기본 접힘 상태로 둔다. 도서 소개·목차도 단계적으로 펼쳐 한 번에 과도한 정보를 노출하지 않는다.


**Create:** src/server/library-search.ts, src/app/api/library-search/route.ts, src/components/curation-details.tsx, tests/library-search.test.ts, e2e/human-owned-library.spec.ts.

**Modify:** src/components/library-app.tsx, src/components/library-forms.tsx, src/components/knowledge-panel.tsx, src/components/thought-map/panel.tsx, src/components/thought-map/timeline.tsx, src/components/thought-map/topic-browser.tsx, src/lib/knowledge.ts, src/app/globals.css, e2e/harness.tsx.

**Interfaces:**
- `searchLibrary(db: Executor, owner: string, query: { text: string; layer: 'all' | 'mine' | 'source' | 'auxiliary'; topicId?: string; cursor?: string }): Promise<{ items: SearchHit[]; nextCursor: string | null }>`.
- SearchHit는 source 참조, 층, 제목, 근거 구절, coverage, 출처를 가지며 한 페이지 20건이다. mine은 개인 기록/판단이며 미확인 인용을 본인 주장이라고 표시하지 않는다.
- GET /api/library-search는 인증한 소유자의 저장된 자료를 검색한다. 기존 connectThoughts/setThoughtEvent를 수동 지도에 재사용한다.

- [ ] **실패 테스트:** AI/PC가 꺼진 E2E에서 빈 입력란→자기 글 저장→태그 선택→검색→두 기록 수동 연결/이유 저장을 검증한다. 보조 태그 숨김이 원문을 지우지 않고 AI 소개가 메모 수에 들어가지 않으며 저장 시 보조 API 요청은 0이다.
- [ ] **실패 확인:** `npm test -- tests/library-search.test.ts`, `npm run test:e2e -- e2e/human-owned-library.spec.ts`.
- [ ] **수동 흐름 구현:** 기본 동작은 기록·주제 선택·직접 연결·변화 이유 쓰기다. 상시 분석 상태/기기 안내는 필요한 설정으로 이동한다. 날짜/발화 주체 미확인은 유지하고 문장 편집을 새 생각 변화로 만들지 않는다.
- [ ] **검색 구현:** 제목·저자·기존 태그·원문을 우선하고 보조 태그 가중치는 낮춘다. 명시적 분야 필터가 없으면 다른 분야와 미분류도 찾는다. 개인 원문 완전 일치를 보조 소개보다 우선한다. 벡터는 사용 가능한 경우만 더하고 모델 없이 키워드 검색이 가능해야 한다. PC에만 있는 PDF의 전체 검색 가능 여부와 온라인 목록 검색을 구분해 표시한다.
- [ ] **출처/수정 구현:** 관련 자료의 유사성과 동의/반론을 구별하고 확정 관계는 사용자 조작으로만 저장한다. 보조 정보를 숨기거나 고칠 수 있고 출처/채택 이력을 보여준다. 개인 태그 일괄 변경은 미리보기와 선택을 거친다.
- [ ] **통과 확인:** 위 명령과 `npm run test:e2e -- e2e/thought-topics.spec.ts e2e/knowledge-pdf.spec.ts`. 모바일 360px/PC에서 보통 사용에 AI 대기가 없어야 한다. 종이책 인용과 설교·논문 자료 수동 선택을 유지한다.
- [ ] **커밋:** `feat: center library on personal writing and retrieval`.

## Task 5: 범위와 비용을 제한한 GPT 연결

**Create:** db/012_library_assist.sql, src/lib/assist.ts, src/local/ai/openai.ts, src/server/ai-usage-store.ts, tests/openai-assist.test.ts, tests/ai-usage-store.test.ts.

**Modify:** scripts/migrate.ts, src/local/ai/evaluation.ts, src/lib/thought-map/types.ts, .env.example.

**Interfaces:**
- AssistPurpose='tag_suggestion'|'excerpt_explanation'|'compare_notes'. AssistInput은 purpose별 판별 union이다. 태그는 메모 1개/최대 5개, 설명은 선택 발췌 최대 3개, 비교는 직접 고른 내 기록 2개다. SourceRef와 필요한 원문·coverage를 포함하고 비교에는 기존 CompareInput을 쓴다.
- AiTask는 `{ phase: 'runtime'; payload: AssistInput } | { phase: 'development'; payload: CurationBatchInput }`. 개발도 한 호출에 한 자료를 다루고 T2 스키마를 반환한다. 100건 묶음은 로컬 진행 단위다.
- `reserveAiUsage(db: Database, owner: string, input: { operationId: string; phase: 'development' | 'runtime'; maxCostUsd: string }): Promise<UsageReservation>`. 기간/작업/요청 한도를 한 트랜잭션에서 검증한다. null 한도는 호출 불가다.
- `runOpenAiTask(task: AiTask, reservation: UsageReservation, config: OpenAiConfig, signal?: AbortSignal): Promise<AiTaskResult>`. config는 PC 키, 모델, 요금표 버전, 제한 시간이다. result는 응답, 사용량, providerRequestId, provider/model/prompt/schema 출처를 포함한다.
- `settleAiUsage(db: Database, owner: string, reservationId: string, outcome: UsageOutcome): Promise<void>`. 사용량 확정/확실한 미송신/과금 불명을 구분한다. API model ID를 로컬 weight digest로 기록하지 않는다.

- [ ] **실패 테스트:** HTTP 모의 실행에서 키 없음/한도 null/예산 부족은 호출 0, 동시 예약도 잔액 초과 불가, 연결 중단 후 unknown은 자동 재전송하지 않음을 검증한다. 거절/불완전 응답/잘못된 JSON/거짓 인용/다른 판본/원문 속 명령은 개인 기록에 반영하지 않는다. 요금표 불명도 실행 0이다.
- [ ] **실패 확인:** `npm test -- tests/openai-assist.test.ts tests/ai-usage-store.test.ts tests/ai-evaluation.test.ts`. 실제 API는 호출하지 않는다.
- [ ] **스키마/제한 구현:** 엄격한 JSON, 본인 발화·일시 검증, UTF-16 인용 범위 일치를 재사용한다. 초기 원문 합계 최대 12,000자, 출력 최대 2,000 tokens, 동시 생성 1건으로 둔다. 글자 수와 token 수를 같게 취급하지 않는다. 스키마·지시문까지 포함한 전체 요청의 보수적인 token 상한으로 비용을 예약하고 추론은 output, cache는 input의 내역으로 기록해 이중 과금 집계를 피한다. 원문 길이가 초과하면 몰래 잘라 전체를 분석한 것처럼 표시하지 않고 범위를 줄이도록 한다.
- [ ] **공급자 구현:** Responses API, store:false, 도구 없음. GPT-6 Luna 후보의 실제 model ID/요금을 구현 시 공식 자료에서 재확인하며 실패해도 더 비싼 모델로 자동 전환하지 않는다. 키는 PC 환경에만 두고 NEXT_PUBLIC/온라인 DB/기기 파일/로그로 내보내지 않는다.
- [ ] **비용 구현:** 개발/운영을 나눠 집계하고 operation ID당 예약을 유일하게 만든다. 송신 여부 불명은 예약 유지·확인 필요로 둔다. 재실행은 명시적 동작이며 추가 과금 가능성을 알린다. 캐시는 owner/원문 버전/모델/프롬프트/스키마로 분리한다. 비교 출처 타입은 기존 로컬 결과를 읽을 수 있게 확장한다.
- [ ] **통과 확인:** 모의 테스트 성공, 브라우저 번들에 키 0. 실제 API는 T7의 조건부 시험 전까지 실행하지 않는다.
- [ ] **커밋:** `feat: add bounded GPT assistance and usage accounting`.

## Task 6: 요청할 때만 작동하는 보조 기능 세 가지

**Create:** src/server/assist-store.ts, src/app/api/assist/route.ts, src/app/api/assist-worker/route.ts, src/local/assist/worker.ts, src/local/assist/transport.ts, scripts/assist-worker.ts, src/components/assist-panel.tsx, tests/assist-store.test.ts, tests/assist-worker.test.ts, e2e/assist.spec.ts.

**Modify:** src/components/library-forms.tsx, src/components/thought-map/timeline.tsx, src/components/thought-map/device-settings.tsx, src/server/thought-device-auth.ts, src/server/curation-export.ts, e2e/harness.tsx, package.json.

**Interfaces:**
- T5에서 정의한 library_assist_requests/results/ai_usage를 사용한다. `createAssistStore(db: Database)`는 request(owner, {requestId, purpose, sources, expectedPolicyVersion}), claim(device), finish(device, lease, result)를 제공한다. 소유자/기기/임대 검증은 기존 인증과 일치시킨다.
- /api/assist: preview/request/status/cancel/채택. 서버가 선택 ID의 소유자와 버전을 확인해 전송 미리보기를 만든다. 미리보기의 실행을 눌렀을 때만 요청한다.
- 같은 인증 API의 정책 설정은 expectedPolicyVersion과 한도를 검증해 T1 정책을 갱신한다. 런타임 보조 허용과 개발 정비 예산은 분리하며 정책을 끄면 미실행 요청을 취소한다. 키 입력/저장은 PC에만 있다.
- /api/assist-worker: 등록 PC의 claim/heartbeat/finish. 기기 해제를 반영하고 T5의 예약 후 호출한다. 결과 저장 실패가 재과금으로 이어지지 않도록 사용량과 응답을 먼저 기록한다.
- `runAssistWorker({ transport, execute, signal }): Promise<void>`. execute는 T5 예약 후 실행, transport는 claim/renew/finish다. 기존 임대 120초/갱신 30초를 따르며 미확정 외부 호출을 다른 기기에 재할당하지 않는다.

- [ ] **실패 테스트:** PC 꺼짐→대기→재연결→결과 1건, PC 둘의 동시 claim, 저장 응답 유실, 해제된 기기, 다른 소유자, 처리 중 원문/정책 변경을 시험한다. 중복/소유자 간 노출/개인 본문 수정/원문 버전 불일치 반영이 모두 0이다. 키·예산 미설정은 이유를 표시하고 일반 기록 동작은 성공해야 한다.
- [ ] **실패 확인:** `npm test -- tests/assist-store.test.ts tests/assist-worker.test.ts`, `npm run test:e2e -- e2e/assist.spec.ts`.
- [ ] **요청/작업기 구현:** 자료·범위 hash를 검증하고 기존 자동 큐를 GPT 큐로 옮기지 않는다. 시작 시 명시적 요청만 확인하며 전체 메모를 분석하지 않는다. 중단된 외부 호출은 과금 불명으로 관리하고 저장된 응답부터 복구한다. 외부 HTTP의 엄밀한 exactly-once를 보장한다고 쓰지 않는다.
- [ ] **검토 화면 구현:** ‘태그 제안’, ‘선택 구절 설명’, ‘두 기록 비교 도움’을 제공한다. 전송 범위·예상 비용 상한·PC 상태를 실행 전에 보여준다. 결과는 별도 카드이며 본문에 넣지 않는다. 태그는 개별 채택, 비교는 기존 후보 검토를 거쳐 사람만 확정한다. 비용 한도와 활성화는 선택 설정에 둔다.
- [ ] **내보내기/오류 구현:** 요구·결과의 원문 참조/작성 출처/채택 이력을 내보낸다. 비용 불명/PC 대기/원문 변경/근거 부족을 구분하고 메모 저장 실패처럼 표시하지 않는다. 아직 평가하지 않은 모델의 비교 기능은 일반 사용을 활성화하지 않는다.
- [ ] **통과 확인:** 위 테스트와 T1의 암묵 요청 0 회귀. PC 연결이 끊겨도 온라인 기록의 검색/수정은 계속 가능해야 한다.
- [ ] **커밋:** `feat: add explicit PC-backed reading assistance`.

## Task 7: 실자료 정비와 AI 없는 사용 검수

**Create:** docs/human-owned-library-acceptance.md, scripts/evaluate-library-assist.ts.

**Modify:** docs/development-library-curation.md, docs/local-ai-operations.md, docs/local-ai-trial-and-next-steps.md, scripts/evaluate-thought-retrieval.ts. 실제 자료와 평가표는 ignored의 private-data/curation/<run-id>/에 저장한다.

**Interfaces:** T3 manifest, T5 결과, 사람의 검수 라벨을 입력한다. 정비 표본 60건, 기록 비교 30쌍, 검색 질문 20개이며 대상 수·미판정·보류·비용·원문 변화 여부를 보고한다.

- [ ] **실자료 기준점:** 실행 직전 소유자 한정 백업·건수를 확인하고 원본 PDF/메모 본문/날짜/독서 이력의 hash 목록을 비공개로 만든다. 과거의 10,994건 등을 현재 값으로 가정하지 않는다.
- [ ] **표본 정비:** T3의 60건을 현재 개발 과정에서 정리한다. Codex 보조 태그·분류·동의어와 근거를 검증해 저장한다. 사용자의 주장·발화 주체·날짜는 자동 확정하지 않는다. 사람의 미판정을 합격으로 세지 않는다.
- [ ] **확대:** 사람의 검수에서 60건 중 90% 이상이 분류·태그 목적에 유용하고 원문 손상 0이면 같은 검증기로 100건씩 확장한다. 미검수·미달 범위는 먼저 고친다. 공식 API 미연결/미추출 범위는 표시한다.
- [ ] **조건부 API 시험:** 키·설정한 상한·전송 범위가 있을 때만 소량 실측한다. 30쌍의 비교는 인용/일시/발화 주체 검증 100%, 사람 검수 유용성 90%를 잠정 운영 기준으로 두고 미달이면 비교 보조를 비활성으로 둔다. 검증된 다른 보조 기능과 수동 기능은 유지한다. API 미설정이면 미실행으로 보고하며 과금하지 않는다.
- [ ] **검색/내보내기 검수:** 같은 20개 질문으로 분야 안/분야 사이/미분류/반론/종이책을 평가한다. 개인 기록의 상위 10개 검색 재현율이 내려가면 보조 태그 가중치를 적용하지 않는다. JSON/Markdown을 별도로 열어 원문·출처·확인/철회 이력을 따라갈 수 있어야 한다.
- [ ] **전체 확인:** `npm test`, `npm run typecheck`, `npm run test:e2e`, `npm run build`, `npm run format:check`. PDF/import가 바뀐 경우 `python -m unittest discover -s scripts -p 'test_*.py'`도 실행한다. AI/API/PC가 없어도 저장·검색·수동 지도·설교/논문 자료 선택을 검수한다.
- [ ] **개발 정비 종료:** 완료 범위를 seal하고 앱 시작·배포로 재실행되지 않음을 확인한다. 잔여 항목·비용·미검수 범위를 정확히 남긴다. 작은 표본을 모델의 일반 성능이나 모든 책의 이해로 확대 해석하지 않는다.
- [ ] **커밋/검토:** 코드와 비개인 검수 결과만 `docs: record human-owned library acceptance`로 저장한다. 직접 순차 구현 뒤 전체 검토를 진행한다. 이번 계획 작성에서 push/배포는 하지 않는다.

## 계획 자체 검토

- 개발 중 정비와 일상의 최소 AI를 분리했다. 앱 첫 실행 정비 기능은 없다.
- 원문/개인 기록 보호는 T1/T2/T3, 일상 화면/검색은 T4, 키/비용/검증은 T5, 명시적 요청/동기화는 T6, 실자료 확대/검수는 T7에 배정했다.
- Review Focus의 다섯 위험에 대응하는 검증을 각 작업에 포함했다.
- T3의 Codex 정비는 별도 API 없이 시작할 수 있다. 유료 처리는 T5와 지정된 예산이 전제다.
- 이번 산출물은 설계와 계획이다. 코드·DB·실자료 수정, API 호출, 운영 전환은 아직 수행하지 않았다.
