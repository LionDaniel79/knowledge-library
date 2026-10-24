"use client";
import { libraryRequest } from "@/client/replica/request";
import { useState } from "react";
import { ResearchPlacementEditor } from "./research-placement-editor";
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
  sections = [],
  onMove,
}: {
  items: ResearchItem[];
  placements: ResearchPlacement[];
  busy: boolean;
  onSave: (payload: unknown) => Promise<unknown> | void;
  onOpen: (kind: string, id: string) => void;
  sections?: string[];
  onMove?: (id: string, direction: -1 | 1) => void;
}) {
  const [removed, setRemoved] = useState(false),
    [history, setHistory] = useState<Record<string, Revision[]>>({}),
    [error, setError] = useState("");
  const map = new Map(placements.map((p) => [p.id, p]));
  const shown = sortResearchItems(items, placements, removed);
  const activeOrder = sortResearchItems(items, placements);
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
          <article className="panel" key={i.id}>
            <small>
              {p?.state === "removed" ? "묶음에서 뺀 자료 · " : ""}
              {p?.section ? `${p.section} · ` : ""}
              {researchRoles[p?.role ?? "background"]}
              {p ? ` · 순서 ${p.position}` : ""}
            </small>
            <h3>{n.title}</h3>
            {onMove && p?.state !== "removed" && (
              <div className="form-footer">
                <button
                  disabled={busy || activeOrder.indexOf(i) === 0}
                  aria-label={`${n.title || "메모"} 위로`}
                  onClick={() => onMove(i.id, -1)}
                >
                  ↑ 위로
                </button>
                <button
                  disabled={
                    busy || activeOrder.indexOf(i) === activeOrder.length - 1
                  }
                  aria-label={`${n.title || "메모"} 아래로`}
                  onClick={() => onMove(i.id, 1)}
                >
                  ↓ 아래로
                </button>
              </div>
            )}
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
              <ResearchPlacementEditor
                id={i.id}
                placement={p}
                index={shown.indexOf(i)}
                sections={sections}
                busy={busy}
                onSave={onSave}
              />
            </details>
            <details
              onToggle={(e) => {
                if (
                  e.target === e.currentTarget &&
                  e.currentTarget.open &&
                  !history[historyKey]
                ) {
                  setError("");
                  void libraryRequest(`/api/revisions/${i.id}`, {
                    cache: "no-store",
                  })
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
