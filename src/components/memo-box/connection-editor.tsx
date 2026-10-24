"use client";
import { useEffect, useState } from "react";
import type { BoardConnection } from "@/lib/whiteboard";
import { relationNames, type Relation } from "@/lib/knowledge";
export function ConnectionEditor({
  connection: c,
  busy,
  onSave,
}: {
  connection: BoardConnection;
  busy: boolean;
  onSave: (p: unknown) => Promise<{ version?: number } | null>;
}) {
  const [base, setBase] = useState(c),
    [relation, setRelation] = useState(c.relation),
    [reason, setReason] = useState(c.reason),
    [dirty, setDirty] = useState(false),
    [waiting, setWaiting] = useState(0);
  useEffect(() => {
    if (!dirty && c.version >= waiting) {
      setBase(c);
      setRelation(c.relation);
      setReason(c.reason);
      setWaiting(0);
    }
  }, [c, dirty, waiting]);
  function edit() {
    if (!dirty) setBase(c);
    setDirty(true);
  }
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const result = await onSave({
          id: c.id,
          expectedVersion: base.version,
          relation,
          reason,
          status: "accepted",
        });
        if (result?.version) {
          setWaiting(result.version);
          setDirty(false);
        }
      }}
    >
      <fieldset disabled={busy} className="placement-fields">
        <label>
          관계
          <select
            name="relation"
            value={relation}
            onChange={(e) => {
              edit();
              setRelation(e.target.value);
            }}
          >
            {Object.entries(relationNames).map(([id, name]) => (
              <option value={id} key={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          연결 이유
          <textarea
            name="reason"
            value={reason}
            onChange={(e) => {
              edit();
              setReason(e.target.value);
            }}
            maxLength={2000}
          />
        </label>
        {dirty && c.version !== base.version && (
          <section className="notice">
            <p>다른 곳에서 연결이 변경됐습니다. 내 입력은 유지됩니다.</p>
            <details>
              <summary>최근 연결 정보</summary>
              <p>
                {relationNames[c.relation as Relation]} ·{" "}
                {c.status === "accepted" ? "연결됨" : "해제됨"}
              </p>
              <p className="preserve-text">{c.reason}</p>
            </details>
            <button type="button" onClick={() => setBase(c)}>
              최근 내용을 확인하고 내 입력 유지
            </button>
          </section>
        )}
        <button disabled={busy}>연결 수정 저장</button>
      </fieldset>
    </form>
  );
}
