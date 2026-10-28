"use client";
import { useEffect, useMemo, useState } from "react";
import type { Library, Note } from "@/lib/domain";
import type { ModalAnchor } from "@/lib/modal-placement";
import type { ResearchItem, ResearchPlacement } from "@/lib/research";
import { seedWritingBoard } from "@/lib/writing-board";
import { containsSearchField } from "@/lib/search-fields";
import { usePagedResource } from "../use-paged-resource";
import { useLibraryCommand } from "../use-library-command";
import { WhiteboardPanel } from "../whiteboard/panel";
type Project = {
  id: string;
  title: string;
  question: string;
  kind: string;
  version: number;
};
type State = {
  research: Project[];
  items: ResearchItem[];
  placements: ResearchPlacement[];
};
export function WritingBoardPanel({
  library,
  ownerId,
  onOpen,
}: {
  library: Library;
  ownerId: string;
  onOpen: (kind: string, id: string, anchor?: ModalAnchor) => void;
}) {
  const resource = usePagedResource<State>(
    "/api/knowledge",
    true,
    library.notes,
    { keepPreviousData: true },
  );
  const command = useLibraryCommand("/api/knowledge", resource.reload);
  const [selected, setSelected] = useState(""),
    [title, setTitle] = useState(""),
    [query, setQuery] = useState("");
  const key = "library:writing-project:" + ownerId;
  useEffect(() => {
    try {
      setSelected(localStorage.getItem(key) ?? "");
    } catch {}
  }, [key]);
  const project =
    resource.data?.research.find((p) => p.id === selected) ??
    resource.data?.research[0];
  const items = useMemo(
    () =>
      resource.data?.items.filter(
        (i) =>
          i.research_id === project?.id &&
          resource.data?.placements.find((p) => p.id === i.id)?.state !==
            "removed",
      ) ?? [],
    [resource.data, project?.id],
  );
  const initial = useMemo(
    () =>
      project
        ? seedWritingBoard(
            project,
            items,
            resource.data?.placements.filter((p) =>
              items.some((i) => i.id === p.id),
            ) ?? [],
          )
        : undefined,
    [project, items, resource.data?.placements],
  );
  const legacyNotes = useMemo<Note[]>(
    () =>
      items.map((item) => ({
        ...item.snapshot.note,
        id: item.snapshot.note.id ?? item.id,
        bookId: item.snapshot.book?.id ?? null,
        kind: item.snapshot.note.kind as Note["kind"],
        version: item.snapshot.note.version,
        createdAt: item.created_at ?? "",
        updatedAt: item.created_at ?? "",
        sourceData: null,
      })),
    [items],
  );
  function choose(id: string) {
    setSelected(id);
    try {
      localStorage.setItem(key, id);
    } catch {}
  }
  return (
    <section className="writing-board-workspace">
      <form
        className="writing-project-create"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          void command
            .send("createResearch", {
              title: title.trim(),
              kind: "thesis",
              question: "",
            })
            .then((p) => {
              if (p) {
                choose(p.id);
                setTitle("");
              }
            });
        }}
      >
        <input
          aria-label="새 글감 제목"
          placeholder="새 글감 제목"
          value={title}
          maxLength={300}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button disabled={command.busy || !title.trim()}>글감 만들기</button>
        {project && <strong>{project.title}</strong>}
      </form>
      {(resource.error || command.error) && (
        <p role="alert">
          {resource.error || command.error}{" "}
          <button onClick={resource.reload}>다시 조회</button>
        </p>
      )}
      {project && initial ? (
        <WhiteboardPanel
          key={project.id}
          library={library}
          ownerId={ownerId}
          onOpen={onOpen}
          boardId={project.id}
          writingTitle={project.title}
          initialBoard={initial}
          legacyNotes={legacyNotes}
        />
      ) : (
        <p role="status">
          {resource.loading
            ? "글감을 여는 중…"
            : "글감을 만들고 목차 상자에 메모를 모아 보세요."}
        </p>
      )}
      <section className="panel writing-project-list" aria-label="글감 목록">
        <div>
          <h3>글감 목록</h3>
          <input
            type="search"
            aria-label="글감 검색"
            placeholder="글감 제목 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {resource.data?.research
          .filter((p) => containsSearchField(p.title, query))
          .map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={project?.id === p.id}
              className={project?.id === p.id ? "selected" : ""}
              onClick={() => choose(p.id)}
            >
              {p.title}
            </button>
          ))}
      </section>
    </section>
  );
}
