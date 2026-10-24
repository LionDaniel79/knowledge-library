"use client";
import { useMemo, useState } from "react";
import type { Library, Note } from "@/lib/domain";
import type { WhiteboardSnapshot } from "@/lib/whiteboard";
import {
  exportResearchMarkdown,
  exportResearchText,
  packOutline,
  unpackOutline,
} from "@/lib/writing";
import {
  sortResearchItems,
  type ResearchItem,
  type ResearchPlacement,
} from "@/lib/research";
import { ResearchBoard } from "../research-board";
import { Modal } from "../modal";
import { usePagedResource } from "../use-paged-resource";
import { useLibraryCommand } from "../use-library-command";
type Project = { id: string; title: string; question: string; kind: string };
type State = {
  research: Project[];
  items: ResearchItem[];
  placements: ResearchPlacement[];
};
export function WritingWorkbench({
  library,
  notes,
  onOpen,
  revision,
}: {
  library: Library;
  notes?: Note[];
  onOpen: (kind: string, id: string) => void;
  revision?: number;
}) {
  const resource = usePagedResource<State>("/api/knowledge", true, revision, {
    keepPreviousData: true,
  });
  const source = usePagedResource<WhiteboardSnapshot>(
    "/api/whiteboard",
    notes === undefined,
    library.notes,
    { keepPreviousData: true },
  );
  const command = useLibraryCommand("/api/knowledge", resource.reload);
  const [selected, setSelected] = useState(""),
    [editing, setEditing] = useState<Project | null>(null),
    [query, setQuery] = useState(""),
    [noteId, setNoteId] = useState("");
  const project =
    resource.data?.research.find((p) => p.id === selected) ??
    resource.data?.research[0];
  const items = useMemo(
    () =>
      resource.data?.items.filter((i) => i.research_id === project?.id) ?? [],
    [resource.data, project?.id],
  );
  const placements = resource.data?.placements ?? [];
  const ordered = sortResearchItems(items, placements),
    map = new Map(placements.map((p) => [p.id, p]));
  const bank = notes ?? source.data?.notes ?? library.notes;
  const available = bank.filter(
    (n) =>
      !items.some((i) => i.snapshot.note.id === n.id) &&
      [n.title, n.content]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  function download(format: "md" | "txt") {
    if (!project) return;
    const text =
      format === "md"
        ? exportResearchMarkdown(project, items, placements)
        : exportResearchText(project, items, placements);
    const url = URL.createObjectURL(
      new Blob([text], {
        type:
          format === "md"
            ? "text/markdown;charset=utf-8"
            : "text/plain;charset=utf-8",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = project.title.replace(/[<>:"/\\|?*]/g, "_") + "." + format;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function move(id: string, direction: -1 | 1) {
    const index = ordered.findIndex((i) => i.id === id),
      target = index + direction;
    if (target < 0 || target >= ordered.length) return;
    const next = [...ordered];
    [next[index], next[target]] = [next[target], next[index]];
    await command.send("moveResearchItems", {
      items: next.map((item, index) => ({
        itemId: item.id,
        expectedVersion: map.get(item.id)?.version ?? 0,
        position: index + 1,
      })),
    });
  }
  return (
    <section className="writing-workbench">
      {(resource.error || source.error || command.error) && (
        <p role="alert">
          {resource.error || source.error || command.error}{" "}
          <button
            onClick={() => {
              resource.reload();
              source.reload();
            }}
          >
            다시 조회
          </button>
        </p>
      )}
      <details className="panel">
        <summary>새 글감 묶음 만들기</summary>
        <ProjectForm
          busy={command.busy}
          onSave={async (p) => {
            const r = await command.send("createResearch", p);
            if (r) {
              setSelected(r.id);
              return true;
            }
            return false;
          }}
        />
      </details>
      {!resource.data && resource.loading && (
        <p role="status">글감 불러오는 중…</p>
      )}
      {project && (
        <>
          <section className="panel">
            <div className="memo-box-toolbar">
              <label>
                글감 묶음
                <select
                  value={project.id}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {resource.data!.research.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.kind === "sermon" ? "설교" : "집필·논문"} · {p.title}
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={() => setEditing({ ...project })}>
                제목·목차 수정
              </button>
              <button
                disabled={command.busy || resource.loading}
                onClick={() => download("md")}
              >
                글감 내려받기 (.md)
              </button>
              <button
                disabled={command.busy || resource.loading}
                onClick={() => download("txt")}
              >
                글감 내려받기 (.txt)
              </button>
            </div>
            <p className="preserve-text">
              {unpackOutline(project.question).question}
            </p>
            {!!unpackOutline(project.question).outline.length && (
              <ol>
                {unpackOutline(project.question).outline.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            )}
            <form
              className="memo-box-toolbar"
              onSubmit={async (e) => {
                e.preventDefault();
                const n = bank.find((n) => n.id === noteId);
                if (
                  n &&
                  (await command.send("addResearchNote", {
                    researchId: project.id,
                    noteId: n.id,
                    expectedNoteVersion: n.version,
                  }))
                )
                  setNoteId("");
              }}
            >
              <label>
                메모 찾기
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="제목·내용"
                />
              </label>
              <label>
                담을 메모
                <select
                  value={noteId}
                  onChange={(e) => setNoteId(e.target.value)}
                  required
                >
                  <option value="">메모 선택</option>
                  {available.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.title || n.content.slice(0, 70)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={
                  command.busy ||
                  !noteId ||
                  !available.some((n) => n.id === noteId)
                }
              >
                출처와 함께 담기
              </button>
            </form>
            <details>
              <summary>서지 내보내기</summary>
              <a href={`/api/bibliography?researchId=${project.id}&format=csl`}>
                서지 JSON
              </a>{" "}
              ·{" "}
              <a href={`/api/bibliography?researchId=${project.id}&format=ris`}>
                서지 RIS
              </a>
            </details>
          </section>
          <ResearchBoard
            items={items}
            placements={placements}
            busy={command.busy}
            onOpen={onOpen}
            onSave={(p) => command.send("placeResearchItem", p)}
            sections={unpackOutline(project.question).outline}
            onMove={(id, d) => void move(id, d)}
          />
        </>
      )}
      {editing && (
        <Modal
          title="제목·목차 수정"
          onClose={() => setEditing(null)}
          canClose={!command.busy}
        >
          <ProjectForm
            project={editing}
            busy={command.busy}
            onSave={async (p) => {
              if (
                await command.send("updateResearch", {
                  id: editing.id,
                  title: p.title,
                  question: p.question,
                  expectedTitle: editing.title,
                  expectedQuestion: editing.question,
                })
              ) {
                setEditing(null);
                return true;
              }
              return false;
            }}
          />
          {command.error && <p role="alert">{command.error}</p>}
        </Modal>
      )}
    </section>
  );
}
function ProjectForm({
  project,
  busy,
  onSave,
}: {
  project?: Project;
  busy: boolean;
  onSave: (p: {
    title: string;
    question: string;
    kind: string;
  }) => Promise<boolean>;
}) {
  const initial = unpackOutline(project?.question ?? "");
  const [error, setError] = useState("");
  return (
    <form
      className="thought-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget,
          f = new FormData(form),
          question = packOutline(
            String(f.get("question") ?? ""),
            String(f.get("outline") ?? "").split("\n"),
          );
        if (question.length > 2000) {
          setError("질문과 목차는 합쳐서 2,000자까지 저장할 수 있습니다.");
          return;
        }
        setError("");
        if (
          await onSave({
            title: String(f.get("title")),
            kind: String(f.get("kind") ?? project?.kind ?? "thesis"),
            question,
          })
        )
          form.reset();
      }}
    >
      <label>
        제목
        <input
          name="title"
          defaultValue={project?.title ?? ""}
          required
          maxLength={300}
        />
      </label>
      {!project && (
        <label>
          용도
          <select name="kind" defaultValue="thesis">
            <option value="thesis">집필·논문</option>
            <option value="sermon">설교</option>
          </select>
        </label>
      )}
      <label>
        탐구할 질문
        <textarea
          name="question"
          defaultValue={initial.question}
          maxLength={2000}
        />
      </label>
      <label>
        목차 · 한 줄에 한 항목
        <textarea
          name="outline"
          defaultValue={initial.outline.join("\n")}
          maxLength={2000}
          placeholder={"첫 생각\n새롭게 알게 된 근거\n나의 결론"}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button disabled={busy}>
        {project ? "제목·목차 저장" : "글감 묶음 만들기"}
      </button>
    </form>
  );
}
