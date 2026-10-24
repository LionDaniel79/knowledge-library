"use client";
import { useEffect, useState } from "react";
import { researchRoles, type ResearchPlacement } from "@/lib/research";
const textKeys = ["role", "section", "comment", "state"] as const;
function fields(p: ResearchPlacement | undefined, index: number) {
  return {
    role: p?.role ?? "background",
    section: p?.section ?? "",
    position: String(p?.position ?? index + 1),
    comment: p?.comment ?? "",
    state: p?.state ?? "active",
  };
}
export function ResearchPlacementEditor({
  id,
  placement: p,
  index,
  sections,
  busy,
  onSave,
}: {
  id: string;
  placement?: ResearchPlacement;
  index: number;
  sections: string[];
  busy: boolean;
  onSave: (p: unknown) => Promise<unknown> | void;
}) {
  const [base, setBase] = useState(() => ({
    values: fields(p, index),
    version: p?.version ?? 0,
  }));
  const [values, setValues] = useState(() => fields(p, index)),
    [dirty, setDirty] = useState(false),
    [positionEdited, setPositionEdited] = useState(false),
    [waiting, setWaiting] = useState(0);
  useEffect(() => {
    if (!dirty && (p?.version ?? 0) >= waiting) {
      const next = fields(p, index);
      setBase({ values: next, version: p?.version ?? 0 });
      setValues(next);
      setPositionEdited(false);
      setWaiting(0);
    }
  }, [p, index, dirty, waiting]);
  const current = fields(p, index),
    contentChanged =
      textKeys.some((k) => current[k] !== base.values[k]) ||
      (positionEdited && current.position !== base.values.position);
  function change(name: keyof typeof values, value: string) {
    if (!dirty) setBase({ values: current, version: p?.version ?? 0 });
    setDirty(true);
    if (name === "position") setPositionEdited(true);
    setValues((old) => ({ ...old, [name]: value }));
  }
  return (
    <form
      className="knowledge-controls"
      onSubmit={async (e) => {
        e.preventDefault();
        const payload = {
          itemId: id,
          expectedVersion: contentChanged ? base.version : (p?.version ?? 0),
          ...values,
          position: Number(positionEdited ? values.position : current.position),
        };
        const result = (await onSave(payload)) as
          { version?: number } | null | undefined;
        if (result?.version) {
          setWaiting(result.version);
          setDirty(false);
        }
      }}
    >
      <fieldset disabled={busy} className="placement-fields">
        <label>
          자료 역할
          <select
            name="role"
            value={values.role}
            onChange={(e) => change("role", e.target.value)}
          >
            {Object.entries(researchRoles).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          장·절 또는 묶음 제목
          <input
            name="section"
            maxLength={300}
            value={values.section}
            onChange={(e) => change("section", e.target.value)}
            list={`writing-sections-${id}`}
          />
          <datalist id={`writing-sections-${id}`}>
            {sections.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <label>
          배치 순서
          <input
            name="position"
            type="number"
            min={1}
            max={100000}
            required
            value={positionEdited ? values.position : current.position}
            onChange={(e) => change("position", e.target.value)}
          />
        </label>
        <label>
          이 자료에 대한 나의 해석
          <textarea
            name="comment"
            maxLength={10000}
            value={values.comment}
            onChange={(e) => change("comment", e.target.value)}
          />
        </label>
        <label>
          자료 상태
          <select
            name="state"
            value={values.state}
            onChange={(e) => change("state", e.target.value)}
          >
            <option value="active">묶음에 포함</option>
            <option value="removed">묶음에서 빼기 · 원문 보존</option>
          </select>
        </label>
        {dirty && contentChanged && (
          <section className="notice">
            <p>다른 곳에서 이 글감이 변경됐습니다. 내 입력은 유지됩니다.</p>
            <details>
              <summary>최근 저장 내용</summary>
              <p>
                {researchRoles[current.role]} · {current.section} ·{" "}
                {current.state === "active" ? "포함" : "제외"}
              </p>
              <p className="preserve-text">{current.comment}</p>
            </details>
            <button
              type="button"
              onClick={() =>
                setBase({ values: current, version: p?.version ?? 0 })
              }
            >
              최근 내용을 확인하고 내 입력 유지
            </button>
          </section>
        )}
        <button disabled={busy}>배치·해석 저장</button>
      </fieldset>
    </form>
  );
}
