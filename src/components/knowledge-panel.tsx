"use client";
import { lazy, Suspense, useEffect, useState } from "react";
import type { Library, Command } from "@/lib/domain";
import type { NewNoteContext } from "@/lib/note-context";
import type { ModalAnchor } from "@/lib/modal-placement";
import { ThoughtMapHelp } from "./thought-map/help";
const WhiteboardPanel = lazy(() =>
  import("./whiteboard/panel").then((m) => ({ default: m.WhiteboardPanel })),
);
const MemoBox = lazy(() =>
  import("./memo-box/panel").then((m) => ({ default: m.MemoBox })),
);
export function KnowledgePanel({
  library,
  onOpen,
  onNewNote = () => {},
  ownerId = "",
  onUpdated = async () => {},
  onSaveNote,
  initialTag = "all",
}: {
  library: Library;
  onOpen: (kind: string, id: string, anchor?: ModalAnchor) => void;
  onNewNote?: (c: NewNoteContext) => void;
  ownerId?: string;
  onUpdated?: () => Promise<void>;
  onSaveNote?: (c: Command) => Promise<void>;
  initialTag?: string;
}) {
  const [tab, setTab] = useState("memo-box"),
    [help, setHelp] = useState(false);
  const tabKey = "library:knowledge-tab:" + ownerId;
  useEffect(() => {
    try {
      setTab(
        initialTag !== "all"
          ? "memo-box"
          : localStorage.getItem(tabKey) === "whiteboard"
            ? "whiteboard"
            : "memo-box",
      );
    } catch {
      setTab("memo-box");
    }
  }, [tabKey, initialTag]);
  return (
    <section className="knowledge-panel">
      <div className="knowledge-tabs">
        {[
          ["whiteboard", "화이트보드"],
          ["memo-box", "메모 상자"],
        ].map(([id, name]) => (
          <button
            key={id}
            className={tab === id ? "primary" : ""}
            onClick={() => {
              setTab(id);
              try {
                localStorage.setItem(tabKey, id);
              } catch {}
            }}
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
        {tab === "whiteboard" ? (
          <WhiteboardPanel
            library={library}
            onOpen={onOpen}
            ownerId={ownerId}
            revision={0}
          />
        ) : (
          <MemoBox
            initialTag={initialTag}
            ownerId={ownerId}
            onUpdated={onUpdated}
            onSaveNote={onSaveNote}
            library={library}
            onOpen={onOpen}
            onNewNote={onNewNote}
            revision={0}
          />
        )}
      </Suspense>
    </section>
  );
}
