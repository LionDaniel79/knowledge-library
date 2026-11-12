"use client";

import { useEffect, useRef, useState } from "react";
import { libraryRequest } from "@/client/replica/request";
import { catalogProviderNames } from "@/lib/book-lookup";

interface AutoBibliographyState {
  version: number;
  application: {
    provider: string;
    url?: string;
    reason: string;
    alternateEdition: boolean;
    status: string;
    fields: string[];
    beforeValues: Record<string, unknown>;
    afterValues: Record<string, unknown>;
    appliedAt: string;
  } | null;
}

const fieldNames: Record<string, string> = {
  title: "제목",
  author: "저자",
  publisher: "출판사",
  isbn: "ISBN",
  coverUrl: "표지 주소",
  category: "분류",
  classification: "분류 근거",
  publicationYear: "출판 연도",
  description: "책 소개",
  toc: "목차",
  referenceIsbn: "참고 판본 ISBN",
  totalPages: "전체 쪽수",
};

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "미입력";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function AutoBibliographyPanel({
  bookId,
  onChanged,
}: {
  bookId: string;
  onChanged: () => Promise<void>;
}) {
  const [opened, setOpened] = useState(false);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<AutoBibliographyState | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"keep" | "undo" | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const submitting = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void libraryRequest(
      `/api/auto-bibliography?bookId=${encodeURIComponent(bookId)}`,
      { cache: "no-store", signal: controller.signal },
      { preferServer: true },
    )
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw Error(result.error ?? "자동 보완 내역을 불러오지 못했습니다.");
        if (controller.signal.aborted) return;
        setState(result);
        setSelected(result.application?.fields ?? []);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "자동 보완 내역을 불러오지 못했습니다.",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [bookId, opened, reload]);

  async function decide(action: "keep" | "undo") {
    if (
      !state?.application ||
      submitting.current ||
      loading ||
      (action === "undo" && !selected.length)
    )
      return;
    submitting.current = true;
    setBusy(action);
    setError("");
    setMessage("");
    try {
      const response = await libraryRequest(
        "/api/auto-bibliography",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookId,
            expectedVersion: state.version,
            action,
            ...(action === "undo" ? { fields: selected } : {}),
          }),
        },
        { preferServer: true, awaitDeviceSync: true },
      );
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 409 && mounted.current) {
          setReload((value) => value + 1);
          setMessage(
            "책 정보가 변경되었습니다. 최신 내역을 확인해 다시 선택해 주세요.",
          );
        }
        throw Error(result.error ?? "자동 보완 내역을 저장하지 못했습니다.");
      }
      if (mounted.current) {
        setState(result);
        setSelected(result.application?.fields ?? []);
        const skipped = Array.isArray(result.skipped)
          ? result.skipped.map((field: string) => fieldNames[field] ?? field)
          : [];
        setMessage(
          (action === "keep"
            ? "자동 보완 정보를 그대로 유지했습니다."
            : "선택한 정보를 이전 값으로 되돌렸습니다.") +
            (skipped.length
              ? ` 이후 수정된 항목은 보존했습니다: ${skipped.join(", ")}.`
              : ""),
        );
      }
      try {
        await onChanged();
      } catch {
        if (mounted.current)
          setError(
            "변경을 저장했습니다. 최신 책 정보를 보려면 책을 다시 열어 주세요.",
          );
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "자동 보완 내역을 저장하지 못했습니다.",
        );
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  const application = state?.application;
  const undone = application?.status === "undone";
  const comparisonFields = application
    ? [
        ...new Set([
          ...Object.keys(application.afterValues),
          ...application.fields,
        ]),
      ]
    : [];
  const canDecide = !!application?.fields.length && !undone;
  const appliedDate = application ? new Date(application.appliedAt) : null;

  return (
    <details
      className="curation-details"
      onToggle={(event) => {
        if (event.target === event.currentTarget && event.currentTarget.open)
          setOpened(true);
      }}
    >
      <summary>자동 보완 내역</summary>
      {loading && <p role="status">자동 보완 내역을 불러오고 있습니다…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {error && !busy && (
        <button
          type="button"
          className="secondary"
          disabled={loading}
          onClick={() => setReload((value) => value + 1)}
        >
          내역 다시 불러오기
        </button>
      )}
      {state && !application && !loading && (
        <p className="muted">자동으로 보완한 정보가 없습니다.</p>
      )}
      {application && (
        <>
          <dl>
            <dt>정보 제공</dt>
            <dd>
              {catalogProviderNames[
                application.provider as keyof typeof catalogProviderNames
              ] ?? application.provider}
              {application.url && /^https:\/\//i.test(application.url) && (
                <>
                  {" · "}
                  <a href={application.url} target="_blank" rel="noreferrer">
                    자료 원문
                  </a>
                </>
              )}
            </dd>
            <dt>보완 시각</dt>
            <dd>
              {appliedDate && !Number.isNaN(appliedDate.getTime())
                ? appliedDate.toLocaleString("ko-KR")
                : application.appliedAt || "기록 없음"}
            </dd>
            <dt>보완 근거</dt>
            <dd className="curation-value">
              {application.reason || "기록 없음"}
            </dd>
            <dt>판본</dt>
            <dd>
              {application.alternateEdition
                ? "다른 판본의 정보를 참고해 보완"
                : "동일 판본의 정보로 보완"}
            </dd>
          </dl>
          {undone ? (
            <p className="muted">이 자동 보완은 이전 정보로 되돌렸습니다.</p>
          ) : application.status === "kept" ? (
            <p className="muted">자동 보완 정보를 유지하기로 선택했습니다.</p>
          ) : (
            <p className="form-hint">
              이전 값으로 되돌릴 항목을 선택해 주세요. 보완 후 직접 수정한 값은
              보존됩니다.
            </p>
          )}
          {comparisonFields.map((field) => (
            <article className="curation-item" key={field}>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={selected.includes(field)}
                  disabled={
                    !!busy ||
                    loading ||
                    undone ||
                    !application.fields.includes(field)
                  }
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setSelected((previous) =>
                      checked
                        ? [...previous, field]
                        : previous.filter((value) => value !== field),
                    );
                  }}
                />
                {fieldNames[field] ?? field}
              </label>
              <dl>
                <dt>이전</dt>
                <dd className="curation-value">
                  {displayValue(application.beforeValues[field])}
                </dd>
                <dt>자동 보완</dt>
                <dd className="curation-value">
                  {displayValue(application.afterValues[field])}
                </dd>
              </dl>
            </article>
          ))}
          {canDecide && (
            <div className="detail-actions" aria-busy={!!busy}>
              {application.status !== "kept" && (
                <button
                  type="button"
                  className="secondary"
                  disabled={!!busy || loading}
                  onClick={() => void decide("keep")}
                >
                  {busy === "keep" ? "저장 중…" : "그대로 유지"}
                </button>
              )}
              <button
                type="button"
                className="secondary"
                disabled={!!busy || loading || !selected.length}
                onClick={() => void decide("undo")}
              >
                {busy === "undo" ? "되돌리는 중…" : "이전 정보로 되돌리기"}
              </button>
            </div>
          )}
        </>
      )}
    </details>
  );
}
