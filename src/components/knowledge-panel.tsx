"use client";
import { lazy, Suspense, useState } from "react";
import type { Library, Command } from "@/lib/domain";
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
  onUpdated = async () => {},
  onSaveNote,
}: {
  library: Library;
  onOpen: (kind: string, id: string) => void;
  onNewNote?: (c: NewNoteContext) => void;
  ownerId?: string;
  onUpdated?: () => Promise<void>;
  onSaveNote?: (c: Command) => Promise<void>;
}) {
  const [tab, setTab] = useState("topics"),
    [help, setHelp] = useState(false);
  return (
    <section className="knowledge-panel">
      <div className="knowledge-tabs">
        {[
          ["topics", "내 기록"],
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
        <button aria-haspopup="dialog" onClick={() => setHelp(true)}>
          사용법
        </button>
      </div>
      {help && <ThoughtMapHelp onClose={() => setHelp(false)} />}
      <Suspense fallback={<p role="status">자료를 여는 중…</p>}>
        {tab === "topics" ? (
          <ThoughtMapPanel
            view="topics"
            onUpdated={onUpdated}
            onSaveNote={onSaveNote}
            onNewNote={onNewNote}
            library={library}
            ownerId={ownerId}
            onOpen={onOpen}
            revision={0}
          />
        ) : tab === "whiteboard" ? (
          <WhiteboardPanel
            library={library}
            onOpen={onOpen}
            ownerId={ownerId}
            revision={0}
          />
        ) : tab === "memo-box" ? (
          <MemoBox
            library={library}
            onOpen={onOpen}
            onNewNote={onNewNote}
            revision={0}
          />
        ) : (
          <WritingWorkbench library={library} onOpen={onOpen} revision={0} />
        )}
      </Suspense>
    </section>
  );
}
