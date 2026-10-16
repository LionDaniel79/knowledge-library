"use client";
import { useState } from "react";
import {
  thoughtRelationNames,
  type Candidate,
  type Feedback,
} from "@/lib/thought-map/types";
import type { ThoughtSend } from "./topic-picker";
export function ReviewCard({
  candidate: c,
  send,
  busy,
  onOpen,
  feedback = [],
}: {
  candidate: Candidate;
  send: ThoughtSend;
  busy: boolean;
  onOpen: (kind: string, id: string) => void;
  feedback?: Feedback[];
}) {
  const [relation, setRelation] = useState(c.comparison.relation),
    [reason, setReason] = useState("relevant"),
    [explanation, setExplanation] = useState(c.comparison.explanation);
  return (
    <article className="panel thought-candidate">
      <small>
        {c.provenance.route === "same_topic"
          ? "같은 주제에서 발견"
          : c.provenance.route === "neighbor_topic"
            ? "연결된 주제에서 발견"
            : c.provenance.route === "global"
              ? "전체 자료·다른 분야에서 발견"
              : "직접 연결"}
      </small>
      <h3>
        {c.before.occurredOn ?? "날짜 미상"} →{" "}
        {c.after.occurredOn ?? "날짜 미상"}
      </h3>
      <p>
        {c.status === "accepted"
          ? "내가 확인한 변화"
          : c.status === "rejected"
            ? "거절한 후보"
            : "검토 전 제안"}
      </p>
      {c.outdated && (
        <p className="notice">
          분석 뒤 원문 또는 날짜·발화 주체가 바뀌었습니다. 다시 검토할 상태로
          돌리고 재분석해 주세요.
        </p>
      )}
      <div className="evidence-pair">
        {(["before", "after"] as const).map((side) => (
          <div key={side}>
            <strong>
              {side === "before" ? "이전 기록의 근거" : "이후 기록의 근거"}
            </strong>
            <blockquote>
              {c.comparison[side]?.quote ?? "확인 가능한 근거 없음"}
            </blockquote>
            <button onClick={() => onOpen("note", c[side].id)}>
              원래 기록 보기 · {c[side].version}판
            </button>
          </div>
        ))}
      </div>
      <div className="thought-form">
        <label>
          변화 판단
          <select
            value={relation}
            onChange={(e) => setRelation(e.target.value as typeof relation)}
          >
            {Object.entries(thoughtRelationNames).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          검토 이유
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="relevant">관련 있음 · 입장이 달라도 포함</option>
            <option value="wrong_relation">변화의 종류가 틀림</option>
            <option value="not_my_view">내 입장이 아님</option>
            <option value="insufficient_evidence">근거 부족</option>
            <option value="irrelevant">이 주제와 관련 없음</option>
            <option value="duplicate">중복된 연결</option>
            <option value="other">다른 이유</option>
          </select>
        </label>
        <label>
          검토 설명
          <textarea
            value={explanation}
            maxLength={1200}
            onChange={(e) => setExplanation(e.target.value)}
          />
        </label>
        <div className="thought-actions">
          {(["accept", "reject", "reopen"] as const).map((decision) => (
            <button
              key={decision}
              disabled={
                busy ||
                (decision === "accept" &&
                  (c.outdated || relation === "uncertain"))
              }
              className={decision === "accept" ? "primary" : ""}
              onClick={() =>
                void send("decideCandidate", {
                  id: c.id,
                  expectedVersion: c.version,
                  decision,
                  relation,
                  reason,
                  explanation,
                })
              }
            >
              {decision === "accept"
                ? "내 판단으로 확정"
                : decision === "reject"
                  ? "후보 거절"
                  : "다시 검토"}
            </button>
          ))}
        </div>
      </div>
      <details>
        <summary>분석 근거와 이력 정보</summary>
        {feedback
          .filter((f) => f.candidateId === c.id)
          .sort(
            (a, b) =>
              a.createdAt.localeCompare(b.createdAt) ||
              a.id.localeCompare(b.id),
          )
          .map((f) => (
            <article key={f.id}>
              <strong>
                {f.createdAt.slice(0, 10)} ·{" "}
                {f.decision === "accept"
                  ? "판단 확정"
                  : f.decision === "reject"
                    ? "후보 거절"
                    : "다시 검토"}
              </strong>
              <p>
                {f.correctedOutput?.explanation ?? f.originalOutput.explanation}
              </p>
              <small>
                {
                  thoughtRelationNames[
                    (f.correctedOutput ?? f.originalOutput).relation
                  ]
                }
              </small>
            </article>
          ))}
        <p>
          {c.provenance.provider === "openai"
            ? "선택한 기록에 대한 GPT 제안"
            : c.provenance.modelDigest === "manual"
              ? "직접 연결"
              : "이전에 저장한 제안"}{" "}
          · 생성일 {c.createdAt.slice(0, 10)}
        </p>
        <p>
          검색 방식 {c.provenance.retrievalVersion} · 기록 버전{" "}
          {c.before.version} / {c.after.version}
        </p>
        {c.context.map((x) => (
          <p key={x.id}>
            {x.coverage === "metadata"
              ? "서지 정보"
              : x.coverage === "partial"
                ? "일부 원문"
                : "기록 맥락"}
            : {x.text}
          </p>
        ))}
      </details>
    </article>
  );
}
export function CandidateReview({
  candidates,
  send,
  busy,
  onOpen,
  feedback,
}: {
  candidates: Candidate[];
  send: ThoughtSend;
  busy: boolean;
  onOpen: (kind: string, id: string) => void;
  feedback?: Feedback[];
}) {
  const [status, setStatus] = useState("pending");
  const shown = candidates.filter((c) => c.status === status);
  return (
    <div>
      <div className="panel">
        <h2>근거를 읽고 내가 판단하기</h2>
        <p>
          유사한 문장만으로 동의·반론·입장 전환을 확정하지 않습니다. 확인한
          판단을 다음 검색에 반영합니다.
        </p>
        <label>
          검토 상태
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="pending">검토할 후보</option>
            <option value="accepted">확정한 변화</option>
            <option value="rejected">거절한 후보</option>
          </select>
        </label>
      </div>
      {shown.map((c) => (
        <ReviewCard
          key={`${c.id}:${c.version}`}
          candidate={c}
          send={send}
          busy={busy}
          onOpen={onOpen}
          feedback={feedback}
        />
      ))}
      {!shown.length && (
        <p className="panel">
          해당 후보가 없습니다. 필요한 경우 API 도움을 요청하거나 ‘생각의
          흐름’에서 직접 연결할 수 있습니다.
        </p>
      )}
    </div>
  );
}
