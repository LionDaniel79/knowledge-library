"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Library, Note } from "@/lib/domain";
import type { ModalAnchor } from "@/lib/modal-placement";
import type { ResearchItem, ResearchPlacement } from "@/lib/research";
import { seedWritingBoard } from "@/lib/writing-board";
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
type MergeSource = {
  id: string;
  expectedTitle: string;
  expectedQuestion: string;
  expectedBoardVersion: number;
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
    [pendingDelete, setPendingDelete] = useState<
      (Project & { expectedBoardVersion?: number; loadError?: string }) | null
    >(null),
    [removedIds, setRemovedIds] = useState<string[]>([]);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  const [pendingRename, setPendingRename] = useState<Project | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [pendingMerge, setPendingMerge] = useState<{
    projects: Project[];
    sources?: MergeSource[];
    loadError?: string;
  } | null>(null);
  const [mergeTitle, setMergeTitle] = useState("");
  const boardFlush = useRef<(() => Promise<void>) | null>(null);
  const registerBoardFlush = useCallback(
    (flush: (() => Promise<void>) | null) => {
      boardFlush.current = flush;
    },
    [],
  );
  const key = "library:writing-project:" + ownerId;
  useEffect(() => {
    try {
      setSelected(localStorage.getItem(key) ?? "");
    } catch {}
  }, [key]);
  const projects = (resource.data?.research ?? []).filter(
    (p) => !removedIds.includes(p.id),
  );
  const checkedProjects = projects.filter((p) => checkedIds.includes(p.id));
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
  async function prepareMerge(selectedProjects?: Project[]) {
    const selected = selectedProjects ?? checkedProjects;
    if (selected.length < 2 || selected.length > 50) return;
    setPendingMerge({ projects: selected });
    try {
      if (selected.some((p) => p.id === project?.id))
        await boardFlush.current?.();
      const sources = await Promise.all(
        selected.map(async (p): Promise<MergeSource> => {
          const response = await libraryRequest(
            `/api/whiteboard?view=summary&boardId=${p.id}`,
            {
              cache: "no-store",
              signal: AbortSignal.timeout(15000),
            },
          );
          const summary = await response.json();
          if (!response.ok)
            throw Error(summary.error || "글감 정보를 확인하지 못했습니다.");
          if (!Number.isInteger(summary.version) || summary.version < 0)
            throw Error("글감 정보를 다시 확인해 주세요.");
          return {
            id: p.id,
            expectedTitle: p.title,
            expectedQuestion: p.question,
            expectedBoardVersion: summary.version,
          };
        }),
      );
      setPendingMerge((old) =>
        old?.projects === selected ? { ...old, sources } : old,
      );
    } catch (error) {
      setPendingMerge((old) =>
        old?.projects === selected
          ? { ...old, loadError: (error as Error).message }
          : old,
      );
    }
  }
  async function mergeProjects() {
    if (!pendingMerge?.sources || !mergeTitle.trim() || command.busy) return;
    const result = await command.send("mergeWritingProjects", {
      title: mergeTitle.trim(),
      sources: pendingMerge.sources,
    });
    if (!result?.id) return;
    choose(result.id);
    setPendingMerge(null);
    setMergeTitle("");
  }
  async function renameProject() {
    if (!pendingRename || !renameTitle.trim() || command.busy) return;
    const result = await command.send("updateResearch", {
      id: pendingRename.id,
      title: renameTitle.trim(),
      question: pendingRename.question,
      expectedTitle: pendingRename.title,
      expectedQuestion: pendingRename.question,
    });
    if (result) setPendingRename(null);
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
    setCheckedIds((ids) => ids.filter((id) => id !== p.id));
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
          onRegisterFlush={registerBoardFlush}
        />
      ) : (
        <p role="status">
          {resource.loading
            ? "글감을 여는 중…"
            : "글감을 만들고 목차 상자에 메모를 모아 보세요."}
        </p>
      )}
      <section className="panel writing-project-list" aria-label="글감 선택">
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
        <div className="writing-project-merge">
          <span>{checkedProjects.length}개 선택</span>{" "}
          <button
            type="button"
            disabled={
              command.busy ||
              checkedProjects.length < 2 ||
              checkedProjects.length > 50
            }
            onClick={() => {
              setMergeTitle("");
              void prepareMerge();
            }}
          >
            선택 글감 합치기
          </button>
          <small>두 개 이상 선택하면 새 글감으로 합칩니다.</small>
        </div>
        {projects.map((p) => (
          <div key={p.id} className="writing-project-row">
            <input
              type="checkbox"
              aria-label={`${p.title} 합치기 선택`}
              checked={checkedIds.includes(p.id)}
              disabled={command.busy}
              onChange={(e) =>
                setCheckedIds((ids) =>
                  e.target.checked
                    ? [...ids, p.id]
                    : ids.filter((id) => id !== p.id),
                )
              }
            />
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
              aria-label={`${p.title} 제목 변경`}
              disabled={command.busy}
              onClick={() => {
                setPendingRename(p);
                setRenameTitle(p.title);
              }}
            >
              제목 변경
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
      {pendingRename && (
        <Modal
          title="글감 제목 변경"
          canClose={!command.busy}
          onClose={() => setPendingRename(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void renameProject();
            }}
          >
            <label>
              변경할 글감 제목
              <input
                aria-label="변경할 글감 제목"
                value={renameTitle}
                maxLength={300}
                onChange={(e) => setRenameTitle(e.target.value)}
              />
            </label>
            {command.error && <p role="alert">{command.error}</p>}
            <div className="form-footer">
              <button disabled={command.busy || !renameTitle.trim()}>
                {command.busy ? "변경 중…" : "변경"}
              </button>
              <button
                type="button"
                disabled={command.busy}
                onClick={() => setPendingRename(null)}
              >
                취소
              </button>
            </div>
          </form>
        </Modal>
      )}
      {pendingMerge && (
        <Modal
          title="글감 합치기"
          canClose={!command.busy}
          onClose={() => setPendingMerge(null)}
        >
          <p>
            선택한 {pendingMerge.projects.length}개 글감을 새 글감으로 합칩니다.
            원본 글감은 그대로 유지됩니다.
          </p>
          <ul>
            {pendingMerge.projects.map((p) => (
              <li key={p.id}>{p.title}</li>
            ))}
          </ul>
          <label>
            합친 글감 제목
            <input
              aria-label="합친 글감 제목"
              value={mergeTitle}
              maxLength={300}
              onChange={(e) => setMergeTitle(e.target.value)}
            />
          </label>
          {command.error && <p role="alert">{command.error}</p>}
          {pendingMerge.loadError ? (
            <p role="alert">
              {pendingMerge.loadError}{" "}
              <button
                type="button"
                onClick={() => void prepareMerge(pendingMerge.projects)}
              >
                다시 확인
              </button>
            </p>
          ) : (
            !pendingMerge.sources && (
              <p role="status">선택한 글감 정보를 확인하는 중…</p>
            )
          )}
          <div className="form-footer">
            <button
              type="button"
              disabled={
                command.busy || !pendingMerge.sources || !mergeTitle.trim()
              }
              onClick={() => void mergeProjects()}
            >
              {command.busy ? "합치는 중…" : "새 글감으로 합치기"}
            </button>
            <button
              type="button"
              disabled={command.busy}
              onClick={() => setPendingMerge(null)}
            >
              취소
            </button>
          </div>
        </Modal>
      )}
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
