"use client";
import {
  mergeBookInformation,
  informationValueKey,
  pendingAutomaticFields,
  informationFieldNames,
  type AutomaticInformation,
} from "../lib/unified-book-information";
import { libraryRequest } from "@/client/replica/request";
import { useEffect, useRef, useState } from "react";
import { useReplicaOptional } from "./replica/provider";
import { displayProviderText } from "../lib/provider-text";
import { PdfOutlineView } from "./pdf-outline";
import { PrintedTocView } from "./printed-toc";
import { printedTocSchema, editPrintedToc } from "../lib/printed-toc";
import {
  pdfOutlineSchema,
  editOutlineDraft,
  formatOutlineDraft,
} from "../lib/pdf-outline";
const kindNames: Record<string, string> = {
  tag: "검색 태그",
  topic: "검색 주제",
  alias: "다른 표현",
  description: "도서 소개",
  bibliography: "보강 서지",
  toc: "목차",
  publisher_intro: "제공자 소개 발췌",
  review_digest: "리뷰를 참고한 소개",
  duplicate_candidate: "중복 확인 후보",
};
const originNames: Record<string, string> = {
  rule: "규칙으로 정리",
  codex: "자료 구축 때 AI로 정리",
  api: "AI 제안",
  provider: "서지 제공자",
};
export function CurationDetails({
  kind,
  id,
  onChanged,
  embedded = false,
  automatic,
  automaticSource,
}: {
  kind: "book" | "note";
  id: string;
  onChanged?: () => Promise<void>;
  embedded?: boolean;
  automatic?: AutomaticInformation | null;
  automaticSource?: React.ReactNode;
}) {
  const [state, setState] = useState<any>(null),
    [error, setError] = useState(""),
    [editing, setEditing] = useState<string | null>(null),
    [draft, setDraft] = useState(""),
    [busy, setBusy] = useState(false);
  const replica = useReplicaOptional(),
    loadTicket = useRef(0),
    opened = useRef(embedded);
  const [choices, setChoices] = useState<Record<string, number>>({});
  useEffect(() => {
    setState(null);
    setChoices({});
    setEditing(null);
  }, [kind, id]);
  useEffect(() => {
    if (opened.current) void load().catch((e) => setError(e.message));
  }, [replica?.revision, kind, id]);
  async function load() {
    const ticket = ++loadTicket.current;
    setError("");
    const r = await libraryRequest(
        `/api/curation?kind=${kind}&id=${encodeURIComponent(id)}`,
        { cache: "no-store" },
      ),
      j = await r.json();
    if (!r.ok) throw Error(j.error ?? "정리 정보를 불러오지 못했습니다.");
    if (ticket === loadTicket.current) setState(j);
  }
  async function save(item: any, hidden: boolean) {
    loadTicket.current++;
    setBusy(true);
    setError("");
    try {
      const value =
        editing === item.id
          ? printedTocSchema.safeParse(item.value).success
            ? editPrintedToc(printedTocSchema.parse(item.value), draft)
            : pdfOutlineSchema.safeParse(item.value).success
              ? editOutlineDraft(pdfOutlineSchema.parse(item.value), draft)
              : typeof item.value === "string"
                ? draft
                : JSON.parse(draft)
          : item.value;
      const r = await libraryRequest("/api/curation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          version: item.version,
          value,
          state: hidden ? "hidden" : "active",
        }),
      });
      const j = await r.json();
      if (!r.ok) throw Error(j.error ?? "저장하지 못했습니다.");
      setState((old: any) => ({
        ...old,
        items: old.items.map((i: any) =>
          i.id === item.id
            ? {
                ...i,
                value,
                version: j.version ?? item.version + 1,
                state: hidden ? "hidden" : "active",
              }
            : i,
        ),
      }));
      setEditing(null);
      void load().catch((e) => setError(e.message));
      void onChanged?.().catch((e) => setError(e.message));
    } catch (e) {
      setError(e instanceof Error ? e.message : "입력을 확인해 주세요.");
    } finally {
      setBusy(false);
    }
  }
  async function selectDisplay(
    field: string,
    variant: {
      value: unknown;
      itemIds: string[];
      automatic: boolean;
      current?: boolean;
    },
  ) {
    if (!state || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await libraryRequest(
        "/api/curation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "selectBookField",
            bookId: id,
            expectedVersion: Number(state.version),
            field,
            itemId:
              variant.itemIds[0] ??
              (variant.current && !variant.automatic ? "current" : "automatic"),
            valueKey: informationValueKey(field, variant.value),
          }),
        },
        { preferServer: true, awaitDeviceSync: true },
      );
      const result = await response.json();
      if (!response.ok)
        throw Error(result.error ?? "표시할 정보를 저장하지 못했습니다.");
      await load();
      setChoices({});
      await onChanged?.();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "표시할 정보를 저장하지 못했습니다.",
      );
    } finally {
      setBusy(false);
    }
  }
  const legacy = (
    <details
      className="curation-details"
      onToggle={(e) => {
        if (e.target === e.currentTarget && e.currentTarget.open) {
          opened.current = true;
          if (!state) void load().catch((e) => setError(e.message));
        }
      }}
    >
      <summary>
        {embedded
          ? "추가 정보 수정·숨기기"
          : kind === "book"
            ? "추가 도서 정보"
            : "검색을 위한 정리 정보"}
      </summary>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {state && !state.items.length && (
        <p className="muted">확인된 추가 정보가 아직 없습니다.</p>
      )}
      {state?.items
        .filter((i: any) => i.state === "active")
        .map((item: any) => (
          <article key={item.id} className="curation-item">
            <h4>{kindNames[item.kind] ?? item.kind}</h4>
            {(item.source_stale || item.source_version !== state.version) && (
              <p className="notice">원자료가 변경되어 다시 확인해야 합니다.</p>
            )}
            {editing === item.id ? (
              <label>
                정리 정보 수정
                {printedTocSchema.safeParse(item.value).success && (
                  <span className="form-hint">
                    원문 발췌와 원문 쪽은 보존됩니다. 직접 정리한 문장만
                    수정합니다.
                  </span>
                )}
                {pdfOutlineSchema.safeParse(item.value).success && (
                  <span className="form-hint">
                    한 줄에 한 항목을 적어 주세요. 쪽수를 기록하려면 ‘서론 |
                    12’처럼 입력합니다.
                  </span>
                )}
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
              </label>
            ) : printedTocSchema.safeParse(item.value).success ? (
              <PrintedTocView
                value={item.value}
                stale={item.document_current === false}
              />
            ) : pdfOutlineSchema.safeParse(item.value).success ? (
              <PdfOutlineView
                value={item.value}
                stale={item.document_current === false}
              />
            ) : (
              <p className="curation-value">
                {typeof item.value === "string"
                  ? displayProviderText(item)
                  : Array.isArray(item.value)
                    ? item.value.join(" · ")
                    : Object.entries(item.value)
                        .filter(
                          ([k]) => !["coverUrl", "classification"].includes(k),
                        )
                        .map(
                          ([k, v]) =>
                            `${({ title: "제목", author: "저자", publisher: "출판사", isbn: "ISBN", coverUrl: "표지 주소", category: "분류", classification: "분류 근거" } as Record<string, string>)[k] ?? k}: ${typeof v === "object" ? JSON.stringify(v) : v}`,
                        )
                        .join("\n")}
              </p>
            )}
            <div className="form-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (editing === item.id) void save(item, false);
                  else {
                    setEditing(item.id);
                    setDraft(
                      printedTocSchema.safeParse(item.value).success
                        ? (printedTocSchema.parse(item.value).editedText ??
                            printedTocSchema.parse(item.value).text)
                        : pdfOutlineSchema.safeParse(item.value).success
                          ? formatOutlineDraft(
                              pdfOutlineSchema.parse(item.value),
                            )
                          : typeof item.value === "string"
                            ? displayProviderText(item)
                            : JSON.stringify(item.value, null, 2),
                    );
                  }
                }}
              >
                {editing === item.id ? "수정 저장" : "수정"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void save(item, true)}
              >
                숨기기
              </button>
            </div>
            {!embedded && (
              <details>
                <summary>출처</summary>
                <p>
                  {originNames[item.origin] ?? item.origin} ·{" "}
                  {item.reviewed_by === "catalog_precheck"
                    ? "서지 일치 확인"
                    : item.reviewed_by
                      ? "사용자 확인·수정"
                      : "검토 전"}{" "}
                  ·{" "}
                  {item.coverage === "metadata"
                    ? "서지 정보 범위"
                    : item.coverage === "toc"
                      ? "목차 범위"
                      : item.coverage === "partial"
                        ? "일부 내용 범위"
                        : "기록 전체 범위"}
                </p>
                <blockquote>{item.evidence.quote}</blockquote>
                {state.references
                  .filter((r: any) => r.id === item.evidence.referenceId)
                  .map((r: any) => (
                    <p key={r.id}>
                      {r.provider} · {String(r.retrieved_at).slice(0, 10)}{" "}
                      {/^https:\/\//.test(r.url) && (
                        <a href={r.url} target="_blank" rel="noreferrer">
                          출처 열기
                        </a>
                      )}
                    </p>
                  ))}
                {state.history
                  .filter((h: any) => h.entity_id === item.id)
                  .map((h: any, n: number) => (
                    <small key={n}>
                      {String(h.created_at).slice(0, 10)} ·{" "}
                      {h.reviewer ? "사용자 수정" : "처음 정리"}
                      <br />
                    </small>
                  ))}
              </details>
            )}
          </article>
        ))}
      {!!state?.items.some((i: any) => i.state === "hidden") && (
        <details>
          <summary>숨긴 정리 정보</summary>
          {state.items
            .filter((i: any) => i.state === "hidden")
            .map((i: any) => (
              <p key={i.id}>
                {kindNames[i.kind]}{" "}
                <button disabled={busy} onClick={() => void save(i, false)}>
                  다시 표시
                </button>
              </p>
            ))}
        </details>
      )}
    </details>
  );
  if (!embedded) return legacy;
  const fields = mergeBookInformation(
    state?.items ?? [],
    automatic,
    state?.informationSelections,
    state?.currentInformation,
  );
  function renderValue(value: unknown, field?: string) {
    if (
      field === "classification" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const info = value as Record<string, unknown>;
      return (
        <p className="curation-value">
          {[info.label, info.code, info.source, info.method]
            .filter(Boolean)
            .join(" · ") || "분류 자료 있음"}
        </p>
      );
    }
    if (printedTocSchema.safeParse(value).success)
      return <PrintedTocView value={value} />;
    if (pdfOutlineSchema.safeParse(value).success)
      return <PdfOutlineView value={value} />;
    return (
      <p className="curation-value">
        {typeof value === "string"
          ? value
          : Array.isArray(value)
            ? value.join("\n")
            : JSON.stringify(value, null, 2)}
      </p>
    );
  }
  function sources(value: {
    itemIds: string[];
    automatic: boolean;
    manual: boolean;
    current?: boolean;
    value?: unknown;
  }) {
    const names = value.itemIds.map((id) => {
      const item = state?.items.find((i: any) => i.id === id);
      const ref = state?.references.find(
        (r: any) => r.id === item?.evidence?.referenceId,
      );
      return ref?.provider ?? originNames[item?.origin] ?? "저장 자료";
    });
    if (value.automatic) names.push(automatic?.provider ?? "자동 보완");
    if (value.current) {
      for (const [field, saved] of Object.entries(
        state?.currentInformation?.fields ?? {},
      ))
        if (
          informationValueKey(field, saved) ===
          informationValueKey(field, value.value)
        ) {
          const source = state?.currentInformation?.sources?.[field];
          if (source?.provider) names.push(source.provider);
        }
    }
    if (value.manual) names.push("사용자 수정");
    return [...new Set(names)].join(" · ");
  }
  return (
    <div className="unified-information-values">
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {fields
        .filter(
          (field) =>
            !(
              field.values.length === 1 &&
              field.values[0].automatic &&
              pendingAutomaticFields(automatic).includes(field.field)
            ),
        )
        .map((field) => {
          const chosen = Math.min(
            choices[field.field] ?? 0,
            field.values.length - 1,
          );
          const value = field.values[chosen];
          return (
            <article
              className="curation-item unified-information-field"
              key={field.field}
            >
              <h4>{informationFieldNames[field.field] ?? field.field}</h4>
              {!(
                value.automatic &&
                pendingAutomaticFields(automatic).includes(field.field)
              ) && renderValue(value.value, field.field)}
              <small className="muted">{sources(value)}</small>
              {value.itemIds.some((id) =>
                state?.items.some(
                  (i: any) =>
                    i.id === id &&
                    (i.source_stale || i.source_version !== state.version),
                ),
              ) && (
                <p className="notice">
                  원자료가 변경되어 다시 확인해야 합니다.
                </p>
              )}
              {field.values.length > 1 && (
                <details className="information-alternatives">
                  <summary>다른 값 비교 ({field.values.length - 1})</summary>
                  <p className="form-hint">
                    비교할 값을 고른 뒤 표시할 정보로 저장할 수 있습니다.
                    원자료와 다른 값은 보존됩니다.
                  </p>
                  {field.values.map((variant, index) => (
                    <div key={index} className="information-alternative">
                      <label className="checkbox-label">
                        <input
                          type="radio"
                          name={`information-${id}-${field.field}`}
                          checked={chosen === index}
                          onChange={() =>
                            setChoices((old) => ({
                              ...old,
                              [field.field]: index,
                            }))
                          }
                        />
                        {informationFieldNames[field.field] ?? field.field} 표시{" "}
                        {index + 1}
                      </label>
                      {index !== chosen &&
                        renderValue(variant.value, field.field)}
                      <small className="muted">{sources(variant)}</small>
                    </div>
                  ))}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void selectDisplay(field.field, value)}
                  >
                    표시할 정보 저장
                  </button>
                </details>
              )}
            </article>
          );
        })}
      {state && !fields.length && (
        <p className="muted">확인된 추가 정보가 아직 없습니다.</p>
      )}
      {legacy}
      <details className="information-sources">
        <summary>수집 출처</summary>
        {automaticSource}
        {state?.items.map((item: any) => (
          <article key={item.id} className="information-source">
            <h4>
              {kindNames[item.kind] ?? item.kind}
              {item.state === "hidden" ? " · 숨김" : ""}
            </h4>
            <p>
              {originNames[item.origin] ?? item.origin} ·{" "}
              {item.reviewed_by && item.reviewed_by !== "catalog_precheck"
                ? "사용자 확인·수정"
                : item.reviewed_by
                  ? "서지 일치 확인"
                  : "검토 전"}
            </p>
            <blockquote>{item.evidence?.quote}</blockquote>
            {state.references
              .filter((r: any) => r.id === item.evidence?.referenceId)
              .map((r: any) => (
                <p key={r.id}>
                  {r.provider} · {String(r.retrieved_at).slice(0, 10)}{" "}
                  {/^https:\/\//.test(r.url) && (
                    <a href={r.url} target="_blank" rel="noreferrer">
                      출처 열기
                    </a>
                  )}
                </p>
              ))}
            {state.history
              .filter((h: any) => h.entity_id === item.id)
              .map((h: any, index: number) => (
                <p key={index}>
                  <small>
                    {String(h.created_at).slice(0, 10)} ·{" "}
                    {h.reviewer ? "사용자 수정" : "처음 정리"}
                  </small>
                </p>
              ))}
          </article>
        ))}
      </details>
    </div>
  );
}
