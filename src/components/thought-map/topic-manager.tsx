"use client";
import { useState } from "react";
import { parseTags } from "@/lib/catalog";
import type { ThoughtMapSnapshot, Topic } from "@/lib/thought-map/types";
import type { ThoughtSend } from "./topic-picker";
import { Modal } from "../modal";
export function TopicManager({
  state,
  topics,
  selected,
  onSelect,
  onMove,
  send,
  busy,
  error = "",
}: {
  state: ThoughtMapSnapshot;
  topics: Topic[];
  selected: string;
  onSelect: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  send: ThoughtSend;
  busy: boolean;
  error?: string;
}) {
  const [managing, setManaging] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [deleting, setDeleting] = useState<Topic | null>(null);
  const [editing, setEditing] = useState<Topic | null>(null),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [aliases, setAliases] = useState(""),
    [parentId, setParentId] = useState("");
  const [newDraft, setNewDraft] = useState({
    name: "",
    description: "",
    aliases: "",
    parentId: "",
  });
  function closeForm() {
    if (!editing) setNewDraft({ name, description, aliases, parentId });
    setFormOpen(false);
  }
  function edit(t: Topic | null) {
    setFormOpen(true);
    setEditing(t);
    setName(t?.name ?? newDraft.name);
    setDescription(t?.description ?? newDraft.description);
    setAliases(t?.aliases.join(", ") ?? newDraft.aliases);
    setParentId(t?.parentId ?? newDraft.parentId);
  }
  return (
    <section className="panel thought-topics">
      <div className="topic-heading">
        <h2 aria-label="나의 주제">
          나의 주제 <small>{topics.length}개</small>
        </h2>
        <button
          className="topic-mobile-control"
          aria-expanded={managing}
          aria-controls="topic-manager"
          onClick={() => setManaging(!managing)}
        >
          주제 관리
        </button>
      </div>
      <div
        id="topic-manager"
        className={`topic-manager${managing ? " is-open" : ""}`}
      >
        <button disabled={busy} onClick={() => void send("proposeTopics", {})}>
          기존 태그로 주제 제안
        </button>
        {topics.map((t, index) => (
          <div key={t.id} className="topic-row">
            <button
              aria-pressed={selected === t.id}
              onClick={() => {
                onSelect(t.id);
              }}
            >
              {t.parentId ? "↳ " : ""}
              {t.name}
              {!t.confirmed ? " · 제안" : ""}
            </button>
            <button
              type="button"
              className="topic-order-button"
              disabled={index === 0}
              aria-label={`${t.name} 위로`}
              onClick={() => onMove(t.id, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="topic-order-button"
              disabled={index === topics.length - 1}
              aria-label={`${t.name} 아래로`}
              onClick={() => onMove(t.id, 1)}
            >
              ↓
            </button>
            <button
              disabled={busy}
              aria-label={`${t.name} 주제 수정`}
              onClick={() => edit(t)}
            >
              수정
            </button>
            <button
              disabled={busy}
              aria-label={`${t.name} 주제 삭제`}
              onClick={() => setDeleting(t)}
            >
              삭제
            </button>
          </div>
        ))}
        <button disabled={busy} onClick={() => edit(null)}>
          주제 만들기
        </button>
        {!!state.archivedTopics?.length && (
          <details>
            <summary>삭제한 주제 · {state.archivedTopics.length}개</summary>
            {state.archivedTopics.map((t) => (
              <div key={t.id}>
                {t.name}
                <button
                  disabled={busy}
                  onClick={() =>
                    void send("restoreTopic", {
                      id: t.id,
                      expectedVersion: t.version,
                    })
                  }
                >
                  복원
                </button>
              </div>
            ))}
          </details>
        )}
      </div>
      {formOpen && (
        <Modal
          title={editing ? "주제 수정" : "주제 만들기"}
          onClose={closeForm}
          canClose={!busy}
        >
          <form
            className="thought-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const saved = await send("upsertTopic", {
                ...(editing
                  ? {
                      id: editing.id,
                      expectedVersion: editing.version,
                    }
                  : {}),
                name,
                description,
                aliases: parseTags(aliases),
                parentId: parentId || null,
                kdcCodes: editing?.kdcCodes ?? [],
              });
              if (saved) {
                if (!editing)
                  setNewDraft({
                    name: "",
                    description: "",
                    aliases: "",
                    parentId: "",
                  });
                setFormOpen(false);
              }
            }}
          >
            <label>
              주제 이름
              <input
                value={name}
                maxLength={80}
                required
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              주제 설명
              <textarea
                value={description}
                maxLength={2000}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label>
              별칭 · 쉼표로 구분
              <input
                value={aliases}
                onChange={(e) => setAliases(e.target.value)}
              />
            </label>
            <label>
              상위 주제
              <select
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
              >
                <option value="">상위 없음</option>
                {topics
                  .filter((t) => t.id !== editing?.id)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
            </label>
            <p className="form-hint">
              최대 3단계. 같은 별칭이 있어도 주제를 자동으로 합치지 않습니다.
            </p>
            <button className="primary" disabled={busy}>
              주제 저장
            </button>
            {editing && (
              <button type="button" onClick={() => edit(null)}>
                새 주제 작성
              </button>
            )}
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="주제 삭제 확인"
          onClose={() => setDeleting(null)}
          canClose={!busy}
        >
          <p>
            ‘{deleting.name}’ 주제를 목록에서 삭제할까요? 메모와 기존 판단은
            보존됩니다.
          </p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button
            disabled={busy}
            onClick={async () => {
              if (
                await send("deleteTopic", {
                  id: deleting.id,
                  expectedVersion: deleting.version,
                })
              ) {
                if (selected === deleting.id) onSelect("all");
                if (editing?.id === deleting.id) {
                  edit(null);
                  setFormOpen(false);
                }
                setDeleting(null);
              }
            }}
          >
            주제 삭제
          </button>
          <button onClick={() => setDeleting(null)}>취소</button>
        </Modal>
      )}
    </section>
  );
}
