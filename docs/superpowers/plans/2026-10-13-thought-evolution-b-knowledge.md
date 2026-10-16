# Categorized Thought Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 분야·주제·개념별 자료 탐색, 기록의 시간순 보기, 근거가 있는 변화 후보 검토와 피드백 개인화를 구현한다.

**Architecture:** 새 데이터는 owner-scoped 테이블과 별도 thought-map 모듈에 둔다. 기존 사유 연결·설교/논문 묶음은 보존한다. 로컬 검색은 세 경로를 합치고 원문 버전을 검증한 후보만 온라인 저장한다.

**Tech Stack:** 기존 Next/pg/Zod/Vitest/PGlite/Playwright, Node SQLite FTS5/Float32 벡터, A단계 LocalAi.

**Spec:** `docs/superpowers/specs/2026-10-13-thought-evolution-design.md`; 선행 계약 `2026-10-13-thought-evolution-a-local.md`.

## Global Constraints

- 공식 KDC와 개인 주제·개념을 연결하되 자동 제안을 공식 확인으로 바꾸지 않는다.
- 책의 주장과 독자의 입장을 구분한다. 사용자가 확인한 변화만 확정한다.
- 책·내 기록·PDF 구절은 여러 주제에 연결할 수 있다. 미분류 자료도 검색한다.
- 근거는 실제 저장된 기록의 부분 문자열과 일치해야 한다. 개인 자료는 외부 AI로 전송하지 않는다.
- A단계의 AnalysisRecord/Evidence/Comparison/ContextExcerpt 계약과 상위 계획의 보존 규칙을 적용한다.

## Review Focus

- 원본 작성일이 없는 가져온 메모: 가져온 날짜를 생각 발생일로 사용하지 않음. B1/B4.
- 자동 분류가 틀리거나 분야 크기가 극단적으로 치우침: 전체 자료 경로와 분야별 평가 유지. B3.
- 순환 주제, 별칭 충돌, 사용자가 거절한 자동 태그: 확인 없이 합치거나 재생성하지 않음. B2.
- 원문 편집과 분석/확정이 동시에 일어남: 최신 버전 확인과 초안 유지. B4.
- 단순 의견 차이·나중의 판단 철회: 반론 배제·자동 학습 정답으로 처리하지 않음. B5.

### Task B1: 날짜·발화 주체·주제·판단의 데이터 계약

**Files:** Create `db/007_thought_map.sql`, `src/lib/thought-map/records.ts`, `src/lib/thought-map/commands.ts`, `src/server/thought-map-store.ts`, `tests/thought-map-store.test.ts`; Modify `scripts/migrate.ts`, existing DB test migration lists, `src/server/library-store.ts` export, `src/components/revision-content.tsx` labels.

**Interfaces:** `resolveThoughtRecord(note:Note):AnalysisRecord` plus `dateSource:'native'|'legacy'|'user'|'unknown'`; `createThoughtMapStore(db:Database)` provides `snapshot(owner:string,filter:TimelineFilter):Promise<ThoughtMapSnapshot>`, `mutate(owner:string,command:Command):Promise<MutationResult>`. `TimelineFilter {topicId?:string,from?:string,to?:string,includeUncertain:boolean}`. `ThoughtMapSnapshot {topics:Topic[],memberships:Membership[],topicLinks:TopicLink[],events:ThoughtEvent[],candidates:Candidate[],feedback:Feedback[]}`; define these Zod-derived types in `types.ts`. All mutable entities carry `id,version`; all DB rows carry `owner_id`.

`resolveThoughtRecord` returns eventVersion0 for source-derived defaults; the store overlays the persisted ThoughtEvent version/voice/date before analysis. Candidates also pin both event versions, so editing a date or `내 생각/인용` label invalidates old analysis even if note text is unchanged. Feedback rows are append-only and derive their effective state through revokesId; JSON DTO names map the table fields below to camelCase.

- [ ] **1. Write failing tests:** sourceData.raw.ZTIMESTAMP=null gives `occurredOn:null` even when createdAt is today; positive Core Data timestamp converts from2001 epoch to Asia/Seoul date. PDF/highlight voice=`quote`; native thought/reflection=`self`; imported note/review and claim/evidence defaults=`unconfirmed`. `expect(editOnlyEvents).toHaveLength(1)`, and another owner's event/reference returns404.
- [ ] **2. RED:** `npm test -- tests/thought-map-store.test.ts`.
- [ ] **3. Implement** tables `library_topics` (name,parent_id,aliases,description,kdc_codes,confirmed,version), `library_topic_memberships` (topic_id,source_kind,source_id,source_version,status,method,evidence), `library_topic_links` (source_topic_id,target_topic_id,status,supporting_pairs,version), `library_thought_events` (note_id,occurred_on,date_source,voice,version), `library_evolution_candidates` (before/after note IDs+versions+hashes,topic_id,relation,evidence,explanation,model/prompt/retrieval versions,pair_key,status,version), `library_analysis_feedback` (candidate_id,original_output,corrected_output,reason,decision,revokes_id,created_at). Add composite owner foreign keys for topics/notes and validate polymorphic sources server-side. Existing note revisions supply immutable historical text; do not duplicate full PDFs. Preserve legacy records and seed idempotently by owner/source keys. Snapshot excludes large raw bodies unless detail requested. Export v5 includes new entities and no credentials/vectors.
- [ ] **4. GREEN:** B1 DB tests plus `npm test -- tests/store.test.ts tests/import.test.ts`. Migration repeats without duplicate data; transactions write append-only library_revisions and reuse library_operations request fingerprints.
- [ ] **5. Commit** explicit B1 paths: `feat: store thought events and topic provenance`.

### Task B2: 여러 주제 분류와 탐색 화면

**Files:** Create `src/components/thought-map/topic-browser.tsx`, `src/components/thought-map/topic-picker.tsx`, `src/app/api/thought-map/route.ts`, `tests/thought-topics.test.ts`, `e2e/thought-topics.spec.ts`; Modify B1 store/commands, `src/components/knowledge-panel.tsx`, `src/components/library-forms.tsx`, `src/app/globals.css`.

**Interfaces:** commands `upsertTopic {id?:string,expectedVersion?:number,name,parentId:string|null,aliases:string[],description:string,kdcCodes:string[]}`, `assignTopic {topicId,sourceKind:'book'|'note'|'pdf_chunk',sourceId,sourceVersion,status:'suggested'|'accepted'|'rejected'}`, `linkTopics {sourceTopicId,targetTopicId,supportingPairs:{beforeId:string,afterId:string}[]}`, `setThoughtEvent {noteId,expectedVersion,occurredOn:string|null,voice}`. Name≤80 chars, aliases≤20, hierarchy≤3 levels; reject cycles, ambiguous aliases become separate review items. Automated topic labels never overwrite accepted/rejected memberships.

- [ ] **1. Write failures:** `A→B→A` parenting rejected; assigning one note to two topics persists both; rejected membership remains rejected on rerun; duplicate alias does not merge topics. UI390px/1440px shows multi-selection, `미분류`, `서지·내 기록 기반`, and preserves edited draft after409.
- [ ] **2. RED:** run topic tests and `npx playwright test e2e/thought-topics.spec.ts`.
- [ ] **3. Implement** `GET/POST /api/thought-map` with requireOwner/validateWriteOrigin, Zod size limits and private no-store. Add `주제별 자료 / 생각의 흐름 / 검토할 후보` within the existing map; old connections remain accessible. KDC is a browse facet; concepts can be linked from multiple subject paths without creating hierarchy cycles. Subject cards use definitions and actual excerpts, not model-only summaries. Users edit name/alias/parent/assignment and review cross-topic links with supporting source pairs.

  Each note's thought panel exposes `내 생각 / 책에서 옮긴 구절 / 확인 전` and date/source controls. Existing imported notes remain `확인 전` until the user labels them; do not bulk-guess ownership of claims. Date/voice edits enqueue re-evaluation and invalidate affected candidates with revisions.
- [ ] **4. GREEN:** unit/UI tests and anonymous API401, foreign-owner404; `npm run typecheck`. Existing sermon/thesis UI remains functional.
- [ ] **5. Commit** explicit B2 paths: `feat: browse topics across library subjects`.

### Task B3: 세 경로의 검색과 소량 비교

**Files:** Create `src/local/thought-map/index.ts`, `retrieval.ts`, `analyze.ts` in that directory, `scripts/analyze-thoughts.ts`, `scripts/evaluate-thought-retrieval.ts`, `tests/thought-retrieval.test.ts`, `tests/thought-analysis.test.ts`; Modify `types.ts`, B1 store with internal `saveCandidate`.

**Interfaces:** `RetrievalHit {source:ContextExcerpt['source'],score:number,route:'same_topic'|'neighbor_topic'|'global',excerpt:ContextExcerpt,topicIds:string[]}`; `retrieveRelated(index:ThoughtIndex,query:AnalysisRecord,options:{limit:number,explicitTopicFilter?:string}):Promise<RetrievalHit[]>`; `analyzePair(ai:LocalAi,input:CompareInput):Promise<Comparison|null>`; internal `saveCandidate(owner:string,input:CandidateInput):Promise<MutationResult>`. Export `CandidateInput {comparison:Comparison,before:AnalysisRecord,after:AnalysisRecord,topicId:string|null,provenance:AnalysisProvenance,context:ContextExcerpt[]}` and `AnalysisProvenance {modelDigest:string,promptVersion:string,retrievalVersion:string}`. C uses these exact interfaces.

For context, persist only selected evidence with coverage/signature, never full source text. Final writes and approval validate both note and event versions. An explicit user topic filter restricts all routes; cross-field reservation applies only when that filter is absent. Automatic links need two distinct root sources (a book or independent note), not two chunks of the same PDF.

Additional interfaces: `proposeMemberships(index:ThoughtIndex,source:ContextExcerpt):Promise<Membership[]>` returns at most3 suggested topics with matched terms/excerpts and source version; `proposeTopicLinks(index:ThoughtIndex):Promise<TopicLink[]>` returns suggested topic pairs supported by at least2 distinct source records. `ThoughtIndex` owns one private SQLite path and exposes versioned sources/vectors/topics; no database connection string enters this index. All public TypeScript fields are camelCase and mapped explicitly to DB snake_case.

- [ ] **1. Write failures:** 90 theology vs10 unrelated/other-field fixtures must retain a relevant counseling result in cross-field output; misclassified/unclassified relevant records remain retrievable; aliases alone do not prove stance agreement; long text excerpts retain original offsets; identical edition hits cannot consume all final slots; reject zero/NaN vectors or stale source hash.
- [ ] **2. RED:** `npm test -- tests/thought-retrieval.test.ts tests/thought-analysis.test.ts`.
- [ ] **3. Implement** private SQLite FTS5+versioned embedding cache, tables keyed by owner/source/hash/model digest; metadata docs and note chunks have explicit coverage. Split notes at paragraphs with≤1000 Unicode code points and100 overlap while retaining UTF-16 offsets. Qwen embeddings normalized; lexical matching uses aliases and Korean-aware terms/character trigrams, and all SQL values are bound. Retrieve up to20 per same/neighbor/global route; within each combine lexical+vector ranks with reciprocal-rank constant60. Preserve up to2 relevant cross-field candidates among final6 when available; no forced irrelevant results. Use actual feedback/calibrated threshold for abstention, never similarity as proof of contradiction. Book metadata only selects context; it cannot supply a book-content claim. Compare two distinct self records with increasing known dates; uncertain cases stay unconfirmed. Verify with A2 evaluator and re-read note versions in a transaction before internal save. Dedup `pair_key` excludes model version so model changes cannot resurface a rejected pair.

  Automatic topic proposals reuse existing tags and similarity to topic definitions/confirmed representative excerpts. New names remain proposals; accepted/rejected assignments survive reruns. Topic links combine shared memberships and source-pair similarities, save their evidence, and retain rejected pairs. Coverage indicates whether the evidence is metadata or actual text. Keep proposals separate from official KDC and confirmed personal classifications. Add tests for at most3 proposals, no automatic merge/accept, two-source support and rejected topic links staying rejected.
- [ ] **4. GREEN and evaluation:** compare lexical baseline, uncategorized vectors, three-route retrieval on the same reviewed queries. Report Recall@20, Precision@5, cross-field recall, abstention, p50/p95 and RAM; no labels means no claimed quality improvement. Small Qwen reranker0.6B is a later optional experiment if retrieval errors justify its CPU cost, not a required third loaded model. `analyze-thoughts.ts --dry-run` is default; `--apply` saves only validated pending candidates, never accepted.
- [ ] **5. Commit** explicit B3 paths: `feat: retrieve evidence across topic boundaries`.

### Task B4: 변화 흐름·검토·수동 연결

**Files:** Create `src/components/thought-map/timeline.tsx`, `candidate-review.tsx`, `tests/thought-decisions.test.ts`, `e2e/thought-map.spec.ts`; Modify B1 store, B2 panel/API and revision labels.

**Interfaces:** commands `connectThoughts {beforeId,afterId,relation,explanation}` (creates a manually accepted connection only after explicit save), `decideCandidate {id,expectedVersion,decision:'accept'|'reject'|'reopen',relation,reason,explanation}`, with `reason` in `irrelevant|insufficient_evidence|wrong_relation|not_my_view|duplicate|other`. All decision routes compare current note versions/hashes again.

- [ ] **1. Write failures:** old candidate vs edited note→409 without losing draft; no approval→no confirmed line; quote-vs-self cannot become a personal reversal; unknown/same date→separate undirected comparison; reject→model rerun remains rejected; reopen retains prior feedback/revisions. UI shows both actual sentences and provenance; manual controls work without AI.

  Add a race test where only event voice/date changes after analysis; acceptance must fail409. A manual directed change requires two distinct self records with increasing confirmed dates; unknown/same-date records can be linked as undirected context through the existing knowledge connection feature.
- [ ] **2. RED:** `npm test -- tests/thought-decisions.test.ts`; `npx playwright test e2e/thought-map.spec.ts`.
- [ ] **3. Implement** chronological timeline with unknown dates separated; changing note text does not create another thought event. Source links open existing book/PDF views, and unavailable/changed originals retain stored quotes with clear status. Candidate shows route, comparison, relation dropdown, evidence and optional reason selection. `입장이 다르지만 관련 있음` is a supported decision explanation, not rejection-as-irrelevance. Accept/reject/reopen is transactional and revisioned. Existing accepted links become marked outdated after source edits; display the historical version and offer re-review rather than rewriting history.
- [ ] **4. GREEN:** B4 tests plus prior conflict/quote tests. Check keyboard navigation,390px/1440px and empty/loading/offline/AI-unavailable states.
- [ ] **5. Commit** explicit B4 paths: `feat: review evidence for changes in personal views`.

### Task B5: 피드백을 이용한 추천 개선과 향후 학습 준비

**Files:** Create `src/local/thought-map/feedback.ts`, `ranking.ts`, `scripts/evaluate-personal-ranking.ts`, `scripts/export-thought-training.ts`, `tests/thought-feedback.test.ts`; Modify B3 retrieval and `docs/local-ai-operations.md`.

**Interfaces:** `buildFeedbackProfile(feedback:Feedback[]):FeedbackProfile` (aliases, explicit exclusions, corrected examples, revision); `trainRanker(rows:RankingExample[],split:EvaluationSplit):RankerReport`; `RankingExample {pairKey,bookGroup,timeGroup,features:number[],relevant:boolean}`. `FeedbackProfile` never contains a user ideology score. RankerReport includes dataset/model/config hashes, sample counts and holdout metrics.

- [ ] **1. Write failures:** wrong relation/contrary stance is not an irrelevant label; revocation cancels the earlier label; unreviewed outputs excluded; same pair/book/time group cannot appear in both train and holdout; fewer than100 train judgments or30 independent holdout judgments→no model promotion; poor holdout score keeps previous ranker.
- [ ] **2. RED:** `npm test -- tests/thought-feedback.test.ts`.
- [ ] **3. Implement** immediate use of confirmed aliases, stable rejected-pair exclusion and at most2 reviewed comparison examples within A1's prompt budget. Later CPU ranker is regularized logistic regression on lexical rank/vector similarity/shared topics/source evidence/route features; deterministic group split and versioned rollback. Only explicit relevance decisions train ranking. Training export is opt-in CLI, private JSONL of corrected personal examples; DPO pairs require actual preferred/rejected outputs for the same input. No whole book text, no automated upload, no SFT/DPO/GRPO training command is executed.
- [ ] **4. GREEN:** feedback tests plus retrieval regression and a held-out synthetic ranking trial. Real promotion requires same-corpus Precision@5/Recall@20 and cross-field recall not worsening, with user review of changed examples. Until enough data exists, show `확인한 판단을 검색에 반영` and never claim `강화학습 완료`.
- [ ] **5. Commit** explicit B5 paths: `feat: personalize retrieval from reviewed feedback`.

## Completion

B delivers useful manual browsing/timeline even when local model quality fails A. Existing lexical relations remain readable, source data and reading statistics are unchanged, and any AI result is pending until reviewed. Before C: run relevant unit/UI tests, full build, real DB rollback smoke and verify v5 export excludes secrets/private vectors.
