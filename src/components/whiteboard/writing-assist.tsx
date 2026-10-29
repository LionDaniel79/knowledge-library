"use client";
import { useMemo, useState } from "react";
import type { Library } from "@/lib/domain";
import type { Board, WhiteboardSnapshot } from "@/lib/whiteboard";
import type { SynthesisResult, WritingContext } from "@/lib/assist-synthesis";
import { writingAnalysis } from "@/lib/writing-assist";
import { addChapter, addChapterMaterial } from "@/lib/writing-board";
import { AssistLauncher } from "../assist-panel";
export function WritingAssist({
  library,
  board,
  source,
  boardId,
  title,
  ownerId,
  onOpen,
  onChange,
}: {
  library: Library;
  board: Board;
  source: WhiteboardSnapshot;
  boardId: string;
  title: string;
  ownerId: string;
  onOpen: (kind: string, id: string) => void;
  onChange: (board: Board) => void;
}) {
  const [request, setRequest] = useState<WritingContext["request"]>("ideas"),
    [target, setTarget] = useState("all"),
    [error, setError] = useState("");
  const chapter = board.writing?.chapters.find((c) => c.id === target);
  const analysis = useMemo(
    () =>
      writingAnalysis(
        source,
        board,
        boardId,
        title,
        request,
        chapter?.id ?? null,
      ),
    [source, board, boardId, title, request, chapter?.id],
  );
  function apply(
    suggestion: SynthesisResult["suggestions"][number],
    scope: any,
  ) {
    setError("");
    if (scope.writingContext?.boardId !== boardId) return;
    const kind = scope.writingContext.request;
    const destination = board.writing?.chapters.find(
      (c) => c.id === scope.writingContext.targetChapterId,
    );
    let next = board;
    if (kind === "titles" && destination) {
      next = {
        ...board,
        writing: {
          ...board.writing!,
          chapters: board.writing!.chapters.map((c) =>
            c.id === destination.id
              ? { ...c, title: suggestion.title.slice(0, 300) }
              : c,
          ),
        },
      };
    } else if (kind === "materials") {
      if (!destination) {
        setError("메모를 넣을 목차를 선택하고 다시 요청해 주세요.");
        return;
      }
      const existing = new Set(
        board.writing?.chapters.flatMap((c) =>
          c.items.flatMap((i) => i.noteIds),
        ) ?? [],
      );
      const candidates = new Set<string>(
        scope.writingContext.candidateNoteIds ?? [],
      );
      const ids = suggestion.sourceIndices
        .map((i) => scope.sources?.[i]?.id)
        .filter(
          (id: string) =>
            id &&
            candidates.has(id) &&
            !existing.has(id) &&
            source.notes.some((n) => n.id === id),
        );
      if (!ids.length) {
        setError("이 제안의 메모는 이미 목차에 있습니다.");
        return;
      }
      for (const id of ids) {
        const note = source.notes.find((n) => n.id === id)!;
        next = addChapterMaterial(
          next,
          destination.id,
          {
            id: crypto.randomUUID(),
            order:
              Math.max(
                0,
                ...(next.writing?.chapters
                  .find((c) => c.id === destination.id)
                  ?.items.map((i) => i.order) ?? []),
              ) + 1,
            kind: "note",
            label: note.title || note.content.slice(0, 40),
            noteIds: [id],
            groupIds: [],
          },
          source,
        );
      }
    } else {
      for (const name of kind === "titles"
        ? [suggestion.title]
        : suggestion.outline) {
        if (next.writing?.chapters.some((c) => c.title === name)) continue;
        next = addChapter(next, crypto.randomUUID());
        const added = next.writing!.chapters.at(-1)!;
        added.title = name.slice(0, 300);
      }
    }
    onChange(next);
  }
  return (
    <section className="writing-assist">
      <AssistLauncher
        library={library}
        ownerId={ownerId}
        analysis={analysis}
        onOpen={onOpen}
        onWritingSuggestion={apply}
        enabled={request !== "materials" || !!chapter}
      >
        <div className="writing-tools">
          <label>
            AI 도움 방향
            <select
              value={request}
              onChange={(e) =>
                setRequest(e.target.value as WritingContext["request"])
              }
            >
              <option value="ideas">글감 아이디어 제안</option>
              <option value="titles">목차 상자 제목 추천</option>
              <option value="materials">추가할 메모 추천</option>
            </select>
          </label>
          <label>
            대상 목차
            <select
              value={chapter?.id ?? "all"}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="all">전체 글감</option>
              {board.writing?.chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.order}. {c.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && <p role="alert">{error}</p>}
        {request === "materials" && !chapter && (
          <p>메모를 추천받을 목차를 선택해 주세요.</p>
        )}
      </AssistLauncher>
    </section>
  );
}
