"use client";
import { Modal } from "../modal";
import { useState } from "react";
import { parseTags } from "@/lib/catalog";
import type { Topic } from "@/lib/thought-map/types";
export function TopicEditor({
  topic,
  topics,
  busy,
  error,
  onClose,
  onSave,
}: {
  topic: Topic;
  topics: Topic[];
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (p: unknown) => Promise<void>;
}) {
  const [base, setBase] = useState(topic);
  return (
    <Modal title="주제 수정" onClose={onClose} canClose={!busy}>
      <form
        className="thought-form"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void onSave({
            id: base.id,
            expectedVersion: base.version,
            name: f.get("name"),
            description: f.get("description"),
            aliases: parseTags(String(f.get("aliases") ?? "")),
            parentId: f.get("parentId") || null,
            kdcCodes: base.kdcCodes,
          });
        }}
      >
        <label>
          주제 이름
          <input name="name" defaultValue={base.name} required maxLength={80} />
        </label>
        <label>
          주제 설명
          <textarea
            name="description"
            defaultValue={base.description}
            maxLength={2000}
          />
        </label>
        <label>
          별칭
          <input name="aliases" defaultValue={base.aliases.join(", ")} />
        </label>
        <label>
          상위 주제
          <select name="parentId" defaultValue={base.parentId ?? ""}>
            <option value="">상위 없음</option>
            {topics
              .filter((t) => t.id !== topic.id)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </label>
        {error && <p role="alert">{error}</p>}
        {topic.version !== base.version && (
          <section className="notice">
            <p>다른 곳에서 주제가 변경됐습니다. 내 입력은 유지됩니다.</p>
            <details>
              <summary>최근 주제 정보</summary>
              <p>{topic.name}</p>
              <p className="preserve-text">{topic.description}</p>
            </details>
            <button type="button" onClick={() => setBase(topic)}>
              최근 내용을 확인하고 내 입력 유지
            </button>
          </section>
        )}
        <button disabled={busy}>주제 저장</button>
      </form>
    </Modal>
  );
}
