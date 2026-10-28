"use client";
import { useState } from "react";
import type { Board, WhiteboardSnapshot } from "@/lib/whiteboard";
import { buildScene } from "@/lib/whiteboard";
import {
  addChapter,
  addChapterMaterial,
  exportWritingBoard,
  placeChapterMaterials,
  type WritingMaterial,
} from "@/lib/writing-board";
import { connectedMemoGroups, buildMemoBox } from "@/lib/memo-box";
export function WritingTools({
  title,
  board,
  source,
  selectedNote,
  selectedGroup,
  onChange,
}: {
  title: string;
  board: Board;
  source: WhiteboardSnapshot;
  selectedNote: string | null;
  selectedGroup: string | null;
  onChange: (board: Board) => void;
}) {
  const [target, setTarget] = useState(""),
    [material, setMaterial] = useState("");
  const chapters = board.writing?.chapters ?? [],
    chapter = chapters.find((c) => c.id === target) ?? chapters[0];
  const memoGroups = connectedMemoGroups(source),
    topicPairs = buildMemoBox(source).topicPairs;
  function add(kind: "selected" | "existing") {
    if (!chapter) return;
    let value: Omit<WritingMaterial, "id" | "order"> | undefined;
    if (kind === "selected") {
      const group = buildScene(source, board).groups.find(
        (g) => g.id === selectedGroup,
      );
      const note = source.notes.find((n) => n.id === selectedNote);
      if (group)
        value = {
          kind: group.id.startsWith("topic:") ? "topics" : "notes",
          label: group.title,
          noteIds: group.allNodes.map((n) => n.noteId),
          groupIds: [group.id],
        };
      else if (note)
        value = {
          kind: "note",
          label: note.title || note.content.slice(0, 40),
          noteIds: [note.id],
          groupIds: [],
        };
    } else {
      const group = memoGroups.find((g) => "notes:" + g.id === material);
      const pair = topicPairs.find((p) => "topics:" + p.id === material);
      if (group)
        value = {
          kind: "notes",
          label: group.notes
            .map((n) => n.title || n.content.slice(0, 24))
            .join(" ↔ ")
            .slice(0, 300),
          noteIds: group.notes.map((n) => n.id),
          groupIds: [],
        };
      if (pair) {
        const model = buildMemoBox(source);
        value = {
          kind: "topics",
          label: `${model.topics.get(pair.source)?.name} ↔ ${model.topics.get(pair.target)?.name}`,
          noteIds: source.notes
            .filter((n) =>
              (model.noteTopics.get(n.id) ?? []).some(
                (t) => t === pair.source || t === pair.target,
              ),
            )
            .map((n) => n.id),
          groupIds: [],
        };
      }
    }
    if (value)
      onChange(
        addChapterMaterial(
          board,
          chapter.id,
          {
            ...value,
            id: crypto.randomUUID(),
            order: Math.max(0, ...chapter.items.map((i) => i.order)) + 1,
          },
          source,
        ),
      );
  }
  function download(format: "txt" | "md") {
    const url = URL.createObjectURL(
      new Blob([exportWritingBoard(title, board, source, format)], {
        type: `text/${format === "md" ? "markdown" : "plain"};charset=utf-8`,
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = title.replace(/[<>:"/\\|?*]/g, "_") + "." + format;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="writing-tools">
      <button
        type="button"
        onClick={() => {
          const id = crypto.randomUUID();
          onChange(addChapter(board, id));
          setTarget(id);
        }}
      >
        + 목차 상자
      </button>
      <label>
        넣을 목차
        <select
          aria-label="넣을 목차"
          value={chapter?.id ?? ""}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="" disabled>
            목차 선택
          </option>
          {chapters.map((c) => (
            <option value={c.id} key={c.id}>
              {c.order}. {c.title}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={!chapter || (!selectedNote && !selectedGroup)}
        onClick={() => add("selected")}
      >
        선택한 메모·묶음 넣기
      </button>
      <label>
        연결된 자료
        <select
          aria-label="목차에 넣을 연결된 자료"
          value={material}
          onChange={(e) => setMaterial(e.target.value)}
        >
          <option value="">자료 선택</option>
          <optgroup label="연결된 메모">
            {memoGroups.map((g) => (
              <option key={g.id} value={"notes:" + g.id}>
                {g.notes
                  .map((n) => n.title || n.content.slice(0, 20))
                  .join(" ↔ ")}
              </option>
            ))}
          </optgroup>
          <optgroup label="연결된 주제">
            {topicPairs.map((p) => (
              <option key={p.id} value={"topics:" + p.id}>
                {source.topics.find((t) => t.id === p.source)?.name} ↔{" "}
                {source.topics.find((t) => t.id === p.target)?.name}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      <button disabled={!chapter || !material} onClick={() => add("existing")}>
        목차에 넣기
      </button>
      <button
        type="button"
        disabled={!chapters.length}
        onClick={() =>
          onChange(
            chapters.reduce(
              (b, c) => placeChapterMaterials(b, c.id, source),
              board,
            ),
          )
        }
      >
        목차 안 정렬
      </button>
      <button disabled={!chapters.length} onClick={() => download("txt")}>
        TXT 내보내기
      </button>
      <button disabled={!chapters.length} onClick={() => download("md")}>
        MD 내보내기
      </button>
    </div>
  );
}
