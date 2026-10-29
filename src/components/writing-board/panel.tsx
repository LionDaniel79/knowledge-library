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
import { Modal } from "../modal";
import { libraryRequest } from "@/client/replica/request";
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
    [query, setQuery] = useState(""),
    [pendingDelete, setPendingDelete] = useState<
      (Project & { expectedBoardVersion?: number; loadError?: string }) | null
    >(null),
    [removedIds, setRemovedIds] = useState<string[]>([]);
  const key = "library:writing-project:" + ownerId;
  useEffect(() => {
    try {
      setSelected(localStorage.getItem(key) ?? "");
    } catch {}
  }, [key]);
  const projects = (resource.data?.research ?? []).filter(
    (p) => !removedIds.includes(p.id),
  );
  const project = projects.find((p) => p.id === selected) ?? projects[0];
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
  async function removeProject() {
    const p = pendingDelete;
    if (!p || command.busy || p.expectedBoardVersion === undefined) return;
    const result = await command.send("deleteResearch", {
      id: p.id,
      expectedTitle: p.title,
      expectedQuestion: p.question,
      expectedBoardVersion: p.expectedBoardVersion,
    });
    if (!result) return;
    setRemovedIds((old) => [...old, p.id]);
    if (project?.id === p.id)
      choose(projects.find((project) => project.id !== p.id)?.id ?? "");
    try {
      localStorage.removeItem(`library:whiteboard-draft:${ownerId}:${p.id}`);
      localStorage.removeItem(`library:whiteboard-view:${ownerId}:${p.id}`);
    } catch {}
    setPendingDelete(null);
  }
  async function prepareDelete(p: Project) {
    setPendingDelete(p);
    try {
      const response = await libraryRequest(
        `/api/whiteboard?view=summary&boardId=${p.id}`,
        { cache: "no-store", signal: AbortSignal.timeout(15000) },
      );
      const summary = await response.json();
      if (!response.ok)
        throw Error(summary.error || "글감 정보를 확인하지 못했습니다.");
      if (!Number.isInteger(summary.version) || summary.version < 0)
        throw Error("글감 정보를 다시 확인해 주세요.");
      setPendingDelete((old) =>
        old?.id === p.id
          ? { ...old, expectedBoardVersion: summary.version }
          : old,
      );
    } catch (e) {
      setPendingDelete((old) =>
        old?.id === p.id ? { ...old, loadError: (e as Error).message } : old,
      );
    }
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
          suspended={pendingDelete?.id === project.id}
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
        {projects
          .filter((p) => containsSearchField(p.title, query))
          .map((p) => (
            <div key={p.id} className="writing-project-row">
              <button
                type="button"
                aria-pressed={project?.id === p.id}
                className={project?.id === p.id ? "selected" : ""}
                onClick={() => choose(p.id)}
              >
                {p.title}
              </button>
              <button
                type="button"
                aria-label={`${p.title} 삭제`}
                disabled={command.busy}
                onClick={() => void prepareDelete(p)}
              >
                삭제
              </button>
            </div>
          ))}
      </section>
      {pendingDelete && (
        <Modal
          title="글감 삭제"
          canClose={!command.busy}
          onClose={() => setPendingDelete(null)}
        >
          <p>‘{pendingDelete.title}’를 삭제할까요?</p>
          <p>
            이 글감의 목차와 배치가 삭제됩니다. 원래 메모와 연결 관계는
            유지됩니다.
          </p>
          {command.error && <p role="alert">{command.error}</p>}
          {pendingDelete.loadError && (
            <p role="alert">
              {pendingDelete.loadError}{" "}
              <button
                type="button"
                onClick={() => void prepareDelete(pendingDelete)}
              >
                다시 확인
              </button>
            </p>
          )}
          {pendingDelete.expectedBoardVersion === undefined &&
            !pendingDelete.loadError && (
              <p role="status">글감 정보를 확인하는 중…</p>
            )}
          <div className="form-footer">
            <button
              type="button"
              disabled={
                command.busy || pendingDelete.expectedBoardVersion === undefined
              }
              onClick={() => void removeProject()}
            >
              {command.busy ? "삭제 중…" : "삭제"}
            </button>
            <button
              type="button"
              disabled={command.busy}
              onClick={() => setPendingDelete(null)}
            >
              취소
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
