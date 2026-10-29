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
import { connectedMemoGroups } from "@/lib/memo-box";
import { activeBundleLinks } from "@/lib/thought-bundles";
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
    bundlePairs = activeBundleLinks(
      source.bundles ?? [],
      source.bundleLinks ?? [],
    );
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
      const pair = bundlePairs.find((p) => "bundles:" + p.id === material);
      const bundle = source.bundles?.find((b) => "bundle:" + b.id === material);
      if (bundle)
        value = {
          kind: "notes",
          label: bundle.title,
          noteIds: bundle.note_ids,
          groupIds: ["bundle:" + bundle.id],
        };
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
        const groups = (source.bundles ?? []).filter(
          (b) => b.id === pair.source_id || b.id === pair.target_id,
        );
        value = {
          kind: "notes",
          label: groups.map((b) => b.title).join(" ↔ "),
          noteIds: [...new Set(groups.flatMap((b) => b.note_ids))],
          groupIds: groups.map((b) => "bundle:" + b.id),
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
          <optgroup label="생각 묶음">
            {(source.bundles ?? [])
              .filter((b) => !b.archived_at)
              .map((b) => (
                <option key={b.id} value={"bundle:" + b.id}>
                  {b.title}
                </option>
              ))}
          </optgroup>
          <optgroup label="묶음 연결">
            {bundlePairs.map((p) => (
              <option key={p.id} value={"bundles:" + p.id}>
                {source.bundles?.find((b) => b.id === p.source_id)?.title} ↔{" "}
                {source.bundles?.find((b) => b.id === p.target_id)?.title}
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
