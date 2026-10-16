# Local AI Trial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 현재 PC에서 작은 모델이 한국어 기록을 비교할 수 있는지 속도·메모리·정확한 인용으로 검증한다.

**Architecture:** 앱 요청 안에서 추론하지 않고 별도 로컬 Node 실행기가 Ollama에 요청한다. 이 단계는 소유자 기록을 읽을 수 있지만 온라인 DB에 후보나 관계를 쓰지 않는다.

**Tech Stack:** Node 24+, TypeScript, Zod, Vitest, Ollama Windows 공식 배포판, PowerShell 프로세스 메모리 표본.

**Spec:** `docs/superpowers/specs/2026-10-13-thought-evolution-design.md`; 전체 순서 `2026-10-13-thought-evolution.md`.

## Global Constraints

- AI는 내 PC에서 실행하고 결과를 온라인 개인 서재에 동기화한다. 이 시험 단계에서는 결과도 로컬에만 기록한다.
- 초기 입력은 메모 2–6개, 최대 약 4천 토큰, 결과는 짧은 구조화 데이터로 제한한다.
- 동시에 분석 1건만 실행한다. 모델은 번갈아 적재하고 외부 AI·도구 호출을 허용하지 않는다.
- 상위 계획의 원본·개인정보·현재 저장소 보존 조건을 모두 적용한다.

## Review Focus

- 비슷한 모델 이름이 cloud/큰 모델로 해석됨: 정확한 tag·digest 허용 목록. A1.
- 한국어 입력이 조용히 잘려 근거 문장이 바뀜: 분할 범위·바이트 예산·반환 토큰 수 기록. A1/A2.
- 생성된 설명을 사용자의 실제 입장으로 오인함: 정답은 사용자 검수이며 자동 확정 없음. A2.

### Task A1: 로컬 실행 계약과 안전한 추론 연결

**Files:** Create `src/lib/thought-map/types.ts`, `src/local/ai/ollama.ts`, `src/local/ai/model-manifest.ts`, `scripts/ai-preflight.ps1`, `tests/local-ai.test.ts`; Modify `.env.example`, `.gitignore`.

**Interfaces:** `ModelManifest {tag:string,digest:string,sourceUrl:string,license:string,quantization:string,runtimeVersion:string}`. `AnalysisRecord {id:string,version:number,eventVersion:number,contentHash:string,content:string,occurredOn:string|null,voice:'self'|'quote'|'unconfirmed'}`; eventVersion is0 for a trial without persisted thought-event metadata. `Evidence {noteId:string,noteVersion:number,start:number,end:number,quote:string}` uses JavaScript UTF-16 offsets into the original content. `Comparison {relation:'maintains'|'expands'|'revises'|'reverses'|'uncertain',before:Evidence|null,after:Evidence|null,explanation:string}`. `CompareInput {before:AnalysisRecord,after:AnalysisRecord,context:ContextExcerpt[],examples:Comparison[]}`; `ContextExcerpt {id:string,text:string,source:{kind:'note'|'book_metadata'|'pdf',id:string,version:string,page:number|null},coverage:'metadata'|'toc'|'partial'|'full'}`.

Produces `createLocalAi(config,fetchImpl): LocalAi` with `embed(texts:string[]):Promise<number[][]>`, `compare(input:CompareInput):Promise<{raw:unknown,metrics:RunMetrics}>`, `unload():Promise<void>`; `RunMetrics {wallMs:number,loadMs:number,promptTokens:number,outputTokens:number,modelDigest:string}`. Raw results are not validated decisions. 맥락 자료는 최대4개, 참고 사례는 최대2개이며 이후 계획에서도 이 타입을 사용한다.

`config: LocalAiConfig {origin:string,embedding:ModelManifest,comparison:ModelManifest}`, `fetchImpl:typeof fetch`; `TrialReport` metrics use nullable numbers rather than inventing values when unmeasured. Before loading a model require≥3GiB available RAM; during inference cancel at<1.5GiB, record `memory_pressure`, and do not automatically escalate model size. Required disk headroom is twice the declared download plus2GiB; these are conservative local operating settings, not universal model minimums.

- [ ] **1. Write failing tests** in `tests/local-ai.test.ts`: `expect(()=>createLocalAi(remoteConfig,fakeFetch)).toThrow()` for non-loopback origin; reject a `*-cloud` tag, changed digest, HTTP redirect, malformed JSON, NaN/wrong-dimension vectors and truncated output; assert `tools` absent, `stream:false`, embedding `truncate:false`, and `keep_alive:0` between models. Assert Korean excerpt slicing preserves exact offsets and never silently cuts the middle of a code point.
- [ ] **2. RED:** `npm test -- tests/local-ai.test.ts` must fail because the adapter is absent.
- [ ] **3. Implement** `createLocalAi` against `/api/embed` and `/api/chat`, fixed `http://127.0.0.1:11434`, `redirect:'error'`, 10-minute cancellable timeout, one in-flight request. Schema output, `think:false` only if the runtime reports support, no tools. Start with `qwen3-embedding:0.6b` and Windows llama.cpp-backed `gemma4:e2b` Q4_K_M; resolve/pin installed digest rather than `latest`. Persist provenance and refuse unexpected model updates. Use `num_ctx:8192`, output ceiling768 and a conservative complete-input UTF-8 budget4000 bytes, including instructions/examples; excerpts record omitted context. Reject prompt token counts above4096 and length-terminated output. Budget expansion later requires a validated local tokenizer and a new benchmark.
- [ ] **4. GREEN:** run the A1 tests. Preflight reports available RAM, free disk, existing runtime/version and selected model sizes without secrets. Configure cloud off (`OLLAMA_NO_CLOUD=1`) and loopback only; do not alter an unrelated Ollama installation silently. No installer or model download runs during unit tests.
- [ ] **5. Commit** only A1 paths: `feat: add bounded local AI adapter`.

### Task A2: 재현 가능한 시험과 사용자 검수

**Files:** Create `scripts/benchmark-thought-ai.ts`, `src/local/ai/evaluation.ts`, `tests/ai-evaluation.test.ts`, `tests/fixtures/thought-pairs.json`, `docs/local-ai-operations.md`; Modify `package.json` with `ai:benchmark`.

**Interfaces:** consumes A1. Produces `evaluateComparison(input:CompareInput,raw:unknown):{valid:boolean,errors:string[],comparison:Comparison|null}` and `summarizeTrial(runs:TrialRun[]):TrialReport`; `TrialRun {input:CompareInput,raw:unknown,metrics:RunMetrics,expectedRelation:Comparison['relation']|null,reviewed:boolean,peakWorkingSetBytes:number|null}`. The report separates synthetic and real-data results.

- [ ] **1. Write failures:** exact substring mismatch, wrong note/version, empty evidence for a non-uncertain result, a quote-only pair called reversal, unknown dates and identical note IDs must fail validation. `expect(report.reviewedCount).toBe(0)` and `expect(report.accuracy).toBeNull()` for unreviewed examples. Add six synthetic groups: unrelated, quotation, negation, same stance, expansion, reversal.
- [ ] **2. RED:** `npm test -- tests/ai-evaluation.test.ts`.
- [ ] **3. Implement** schema/offset/version/voice/date checks; a quote or unclear date may be reported only as uncertain, not an inferred personal change. Benchmark CLI writes only to ignored `private-data/ai-trial/`, uses verified-owner SELECT of notes, preserves dates/source fields and never mutates production. Create a review file with at least30 real pairs; leave labels blank until user review. Record cold/warm latency, peak process-family working set, OS available RAM, JSON failures and quote validity. Handle unavailable memory measurements as null. Compare corpus never prints personal contents to console.
- [ ] **4. GREEN and trial:** unit tests first; after plan execution approval, install the official runtime if needed, verify distribution/signature and disk requirements, download only named local models, then run `npm run ai:benchmark -- --synthetic`. Run real samples sequentially, pause on memory pressure rather than starting E4B. Report p50/p95 separately from load time and actual failed cases. No quality pass until the real labels exist. A broad claim of “실시간” is prohibited without measured latency.
- [ ] **5. Commit** code and synthetic fixtures only: `feat: measure local thought comparison quality`. Share the private review artifact by local file link; continue manual taxonomy work while awaiting labels.

## Runtime evidence and handoff

As checked2026-10-13, the registry exposes [Qwen0.6B](https://ollama.com/library/qwen3-embedding:0.6b) at about639MB and the llama.cpp variant of [Gemma E2B](https://ollama.com/library/gemma4:e2b) at about4.6GB. These are download sizes, not measured RAM requirements; recheck before installation. [Chat](https://docs.ollama.com/api/chat), [embeddings](https://docs.ollama.com/api/embed), [local-only configuration](https://docs.ollama.com/faq), [Windows setup](https://docs.ollama.com/windows).

A is done when the reproducible report states what runs, what failed, and which real cases still await review. If quality is inadequate, B's manual features proceed and generated candidates remain experimental/off. No model training is part of A.
