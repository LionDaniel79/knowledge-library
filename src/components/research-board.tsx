"use client";
import { useState } from "react";
import {
  researchRoles,
  sortResearchItems,
  researchCitation,
  type ResearchItem,
  type ResearchPlacement,
} from "@/lib/research";
import type { Revision } from "@/lib/domain";
export function ResearchBoard({
  items,
  placements,
  busy,
  onSave,
  onOpen,
}: {
  items: ResearchItem[];
  placements: ResearchPlacement[];
  busy: boolean;
  onSave: (payload: unknown) => void;
  onOpen: (kind: string, id: string) => void;
}) {
  const [removed, setRemoved] = useState(false),
    [history, setHistory] = useState<Record<string, Revision[]>>({}),
    [error, setError] = useState("");
  const map = new Map(placements.map((p) => [p.id, p]));
  const shown = sortResearchItems(items, placements, removed);
  return (
    <div className="research-board">
      <label className="search-checkbox">
        <input
          type="checkbox"
          checked={removed}
          onChange={(e) => setRemoved(e.target.checked)}
        />
        묶음에서 뺀 자료도 보기
      </label>
      {error && <p role="alert">{error}</p>}
      {shown.length === 0 && (
        <p>위에서 메모를 골라 담으면 역할과 순서를 정할 수 있습니다.</p>
      )}
      {shown.map((i) => {
        const p = map.get(i.id),
          n = i.snapshot.note,
          source = n.sourceData,
          historyKey = `${i.id}:${p?.version ?? 0}`;
        return (
          <article className="panel" key={`${i.id}:${p?.version ?? 0}`}>
            <small>
              {p?.state === "removed" ? "묶음에서 뺀 자료 · " : ""}
              {p?.section ? `${p.section} · ` : ""}
              {researchRoles[p?.role ?? "background"]}
              {p ? ` · 순서 ${p.position}` : ""}
            </small>
            <h3>{n.title}</h3>
            <p className="source-quote">{n.content}</p>
            {p?.comment && (
              <p className="source-quote">
                <strong>나의 해석</strong>
                <br />
                {p.comment}
              </p>
            )}
            <details>
              <summary>출처·당시 기록 확인</summary>
              <p>
                {researchCitation(i)} · 메모 버전 {n.version}
              </p>
              <p>
                담을 당시의 기록입니다. 아래에서 현재 기록을 열어 비교할 수
                있습니다.
              </p>
              {n.id && (
                <button onClick={() => onOpen("note", n.id!)}>
                  현재 메모 열기
                </button>
              )}
              {i.snapshot.book?.id && (
                <button onClick={() => onOpen("book", i.snapshot.book!.id!)}>
                  현재 책 정보 열기
                </button>
              )}
              {source?.app === "PDF" && source.recordId && (
                <a
                  href={`/reader/${encodeURIComponent(source.recordId)}?page=${encodeURIComponent(String(source.raw.pdfPage))}&signature=${encodeURIComponent(String(source.raw.signature))}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  PDF 원문 확인
                </a>
              )}
            </details>
            <details>
              <summary>역할·순서·내 해석 수정</summary>
              <form
                className="knowledge-controls"
                onSubmit={(e) => {
                  e.preventDefault();
                  const d = new FormData(e.currentTarget);
                  onSave({
                    itemId: i.id,
                    expectedVersion: p?.version ?? 0,
                    role: d.get("role"),
                    section: d.get("section"),
                    position: Number(d.get("position")),
                    comment: d.get("comment"),
                    state: d.get("state"),
                  });
                }}
              >
                <label>
                  자료 역할
                  <select name="role" defaultValue={p?.role ?? "background"}>
                    {Object.entries(researchRoles).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  장·절 또는 묶음 제목
                  <input
                    name="section"
                    maxLength={300}
                    defaultValue={p?.section ?? ""}
                  />
                </label>
                <label>
                  배치 순서
                  <input
                    name="position"
                    type="number"
                    min={1}
                    max={100000}
                    required
                    defaultValue={p?.position ?? shown.indexOf(i) + 1}
                  />
                </label>
                <label>
                  이 자료에 대한 나의 해석
                  <textarea
                    name="comment"
                    maxLength={10000}
                    defaultValue={p?.comment ?? ""}
                  />
                </label>
                <label>
                  자료 상태
                  <select name="state" defaultValue={p?.state ?? "active"}>
                    <option value="active">묶음에 포함</option>
                    <option value="removed">묶음에서 빼기 · 원문 보존</option>
                  </select>
                </label>
                <button disabled={busy}>배치·해석 저장</button>
              </form>
            </details>
            <details
              onToggle={(e) => {
                if (
                  e.target === e.currentTarget &&
                  e.currentTarget.open &&
                  !history[historyKey]
                ) {
                  setError("");
                  void fetch(`/api/revisions/${i.id}`, { cache: "no-store" })
                    .then(async (r) => {
                      if (!r.ok) throw Error("수정 이력을 읽지 못했습니다.");
                      const rows = await r.json();
                      setHistory((h) => ({ ...h, [historyKey]: rows }));
                    })
                    .catch((e) => setError(e.message));
                }
              }}
            >
              <summary>배치 수정 이력</summary>
              {history[historyKey]?.length === 0 && (
                <p>수정 이력이 없습니다.</p>
              )}
              {history[historyKey]?.map((r) => {
                const after = r.after as ResearchPlacement;
                return (
                  <p key={r.id}>
                    {new Date(r.createdAt).toLocaleString("ko-KR")} ·{" "}
                    {researchRoles[after.role]} · {after.section} · 순서{" "}
                    {after.position} ·{" "}
                    {after.state === "removed" ? "묶음에서 뺌" : "포함"}
                    <br />
                    {after.comment}
                  </p>
                );
              })}
            </details>
          </article>
        );
      })}
    </div>
  );
}
