"use client";
import { Modal } from "../modal";
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
  return (
    <Modal title="주제 수정" onClose={onClose} canClose={!busy}>
      <form
        className="thought-form"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          void onSave({
            id: topic.id,
            expectedVersion: topic.version,
            name: f.get("name"),
            description: f.get("description"),
            aliases: parseTags(String(f.get("aliases") ?? "")),
            parentId: f.get("parentId") || null,
            kdcCodes: topic.kdcCodes,
          });
        }}
      >
        <label>
          주제 이름
          <input
            name="name"
            defaultValue={topic.name}
            required
            maxLength={80}
          />
        </label>
        <label>
          주제 설명
          <textarea
            name="description"
            defaultValue={topic.description}
            maxLength={2000}
          />
        </label>
        <label>
          별칭
          <input name="aliases" defaultValue={topic.aliases.join(", ")} />
        </label>
        <label>
          상위 주제
          <select name="parentId" defaultValue={topic.parentId ?? ""}>
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
        <button disabled={busy}>주제 저장</button>
      </form>
    </Modal>
  );
}
