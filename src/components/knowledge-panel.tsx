"use client";
import { lazy, Suspense, useState } from "react";
import type { Library } from "@/lib/domain";
import type { NewNoteContext } from "@/lib/note-context";
import { ThoughtMapPanel } from "./thought-map/panel";
import { ThoughtMapHelp } from "./thought-map/help";
const WhiteboardPanel = lazy(() =>
  import("./whiteboard/panel").then((m) => ({ default: m.WhiteboardPanel })),
);
const MemoBox = lazy(() =>
  import("./memo-box/panel").then((m) => ({ default: m.MemoBox })),
);
const WritingWorkbench = lazy(() =>
  import("./memo-box/writing-workbench").then((m) => ({
    default: m.WritingWorkbench,
  })),
);
export function KnowledgePanel({
  library,
  onOpen,
  onNewNote = () => {},
  ownerId = "",
}: {
  library: Library;
  onOpen: (kind: string, id: string) => void;
  onNewNote?: (c: NewNoteContext) => void;
  ownerId?: string;
}) {
  const [tab, setTab] = useState("topics"),
    [help, setHelp] = useState(false),
    [revision, setRevision] = useState(0);
  return (
    <section className="knowledge-panel">
      <div className="knowledge-tabs">
        {[
          ["topics", "주제별 자료"],
          ["whiteboard", "화이트보드"],
          ["memo-box", "메모 상자"],
          ["research", "설교·논문 자료"],
        ].map(([id, name]) => (
          <button
            key={id}
            className={tab === id ? "primary" : ""}
            onClick={() => setTab(id)}
          >
            {name}
          </button>
        ))}
        <button onClick={() => setRevision((n) => n + 1)}>새로고침</button>
        <button aria-haspopup="dialog" onClick={() => setHelp(true)}>
          사용법
        </button>
      </div>
      {help && <ThoughtMapHelp onClose={() => setHelp(false)} />}
      <Suspense fallback={<p role="status">자료를 여는 중…</p>}>
        {tab === "topics" ? (
          <ThoughtMapPanel
            view="topics"
            library={library}
            ownerId={ownerId}
            onOpen={onOpen}
            revision={revision}
          />
        ) : tab === "whiteboard" ? (
          <WhiteboardPanel
            library={library}
            onOpen={onOpen}
            ownerId={ownerId}
            revision={revision}
          />
        ) : tab === "memo-box" ? (
          <MemoBox
            library={library}
            onOpen={onOpen}
            onNewNote={onNewNote}
            revision={revision}
          />
        ) : (
          <WritingWorkbench
            library={library}
            onOpen={onOpen}
            revision={revision}
          />
        )}
      </Suspense>
    </section>
  );
}
