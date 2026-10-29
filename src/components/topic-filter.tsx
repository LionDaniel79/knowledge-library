"use client";
import { useEffect, useState } from "react";
import { FacetPicker } from "./whiteboard/facet-picker";
import { Modal } from "./modal";
import { useLibraryCommand } from "./use-library-command";
export type FilterTopic = {
  id: string;
  name: string;
  version: number;
  confirmed?: boolean;
};
const sameName = (a: string, b: string) =>
  a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
export function TopicFilter({
  topics,
  value,
  onChange,
  values,
  onValuesChange,
  onUpdated,
  onRemoved,
  preview = false,
  ready = true,
  selectAll = false,
}: {
  topics: FilterTopic[];
  value: string;
  onChange: (id: string) => void;
  values?: string[];
  onValuesChange?: (ids: string[]) => void;
  onUpdated: () => Promise<void>;
  onRemoved?: (id: string) => void;
  preview?: boolean;
  ready?: boolean;
  selectAll?: boolean;
}) {
  const [added, setAdded] = useState<FilterTopic[]>([]),
    [removed, setRemoved] = useState<string[]>([]),
    [deleting, setDeleting] = useState<FilterTopic | null>(null),
    [refreshError, setRefreshError] = useState("");
  useEffect(() => {
    const ids = new Set(topics.map((t) => t.id));
    setAdded((old) =>
      old.some((t) => ids.has(t.id)) ? old.filter((t) => !ids.has(t.id)) : old,
    );
    setRemoved((old) =>
      old.some((id) => !ids.has(id)) ? old.filter((id) => ids.has(id)) : old,
    );
  }, [topics, added, removed]);
  const choices = [
    ...topics,
    ...added.filter((t) => !topics.some((current) => current.id === t.id)),
  ].filter((t) => !removed.includes(t.id));
  const command = useLibraryCommand("/api/thought-map", () => {
    setRefreshError("");
    void onUpdated().catch((e) =>
      setRefreshError(
        e instanceof Error ? e.message : "목록을 새로고침하지 못했습니다.",
      ),
    );
  });
  const error = command.error || refreshError;
  return (
    <div className="topic-filter">
      <span>주제</span>
      <FacetPicker
        compact
        label="주제"
        multiple={!!onValuesChange}
        selectAll={selectAll}
        options={[
          { value: "unclassified", label: "미분류" },
          ...choices.map((t) => ({
            value: t.id,
            label: t.name + (t.confirmed === false ? " · 제안" : ""),
          })),
        ]}
        values={values ?? (value === "all" ? [] : [value])}
        onChange={(ids) =>
          onValuesChange ? onValuesChange(ids) : onChange(ids[0] ?? "all")
        }
        management={{
          busy: preview || command.busy || !ready,
          error,
          canCreate: (query) =>
            !!query.trim() &&
            query.trim().length <= 80 &&
            !choices.some((t) => sameName(t.name, query)),
          onCreate: async (query) => {
            const name = query.trim();
            if (
              preview ||
              !ready ||
              !name ||
              choices.some((t) => sameName(t.name, name))
            )
              return;
            const result = await command.send("upsertTopic", {
              name,
              parentId: null,
              aliases: [],
              description: "",
              kdcCodes: [],
            });
            if (result)
              setAdded((old) => [
                ...old,
                {
                  id: result.id,
                  name,
                  version: result.version ?? 1,
                  confirmed: true,
                },
              ]);
          },
          canRemove: (id) =>
            !preview &&
            choices.some(
              (t) =>
                t.id === id && Number.isInteger(t.version) && t.version > 0,
            ),
          onRemove: (id) =>
            setDeleting(choices.find((t) => t.id === id) ?? null),
        }}
      />
      {deleting && (
        <Modal
          title="주제 삭제 확인"
          canClose={!command.busy}
          onClose={() => setDeleting(null)}
        >
          <p>
            ‘{deleting.name}’ 주제를 삭제할까요? 메모 내용은 그대로 남습니다.
          </p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <div className="form-footer">
            <button
              type="button"
              disabled={command.busy}
              onClick={async () => {
                if (
                  await command.send("deleteTopic", {
                    id: deleting.id,
                    expectedVersion: deleting.version,
                  })
                ) {
                  setAdded((old) => old.filter((t) => t.id !== deleting.id));
                  setRemoved((old) => [...old, deleting.id]);
                  if (onValuesChange)
                    onValuesChange(
                      (values ?? []).filter((id) => id !== deleting.id),
                    );
                  else if (value === deleting.id) onChange("all");
                  onRemoved?.(deleting.id);
                  setDeleting(null);
                }
              }}
            >
              주제 삭제
            </button>
            <button
              type="button"
              disabled={command.busy}
              onClick={() => setDeleting(null)}
            >
              취소
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
