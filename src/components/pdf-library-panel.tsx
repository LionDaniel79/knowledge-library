"use client";
import { useCallback, useEffect, useState, useRef } from "react";
import { FileText, Search, RefreshCw, ExternalLink, Quote } from "lucide-react";
import { PdfProgress } from "./pdf-progress";
import { LibraryOperationsPanel } from "./library-operations";
import { PdfConnection } from "./pdf-connection";
import {
  useListPagination,
  PageSizeSelect,
  PageNavigation,
} from "./list-pagination";
import { PcAccess } from "./pc-access";
import type { PdfSummary } from "../lib/pdf-progress";
type PdfDoc = {
  id: string;
  bookId: string;
  title: string;
  author: string;
  relativePath: string;
  bytes: number;
  pageCount?: number;
  indexedPages?: number;
  status?: string;
};
type Hit = {
  extractionMethod?: string;
  status?: string;
  documentId: string;
  bookId: string;
  title: string;
  pageNumber: number;
  quote: string;
  signature: string;
};
const stateNames: Record<string, string> = {
  ocr_review: "문자 인식 완료 · 원문 대조 필요",
  metadata_only: "기본정보만 보관",
  pending: "본문 준비 중",
  indexing: "본문 읽는 중",
  ready: "본문 검색 가능",
  partial_ocr: "일부 페이지 문자 인식 필요",
  needs_ocr: "문자 인식 필요",
  error: "파일 확인 필요",
  locked: "암호 필요",
  changed: "원본 변경됨",
  missing: "파일 연결 끊김",
};
export function PdfLibraryPanel({
  onSaved,
  documentId,
  initialOperationsOpen = false,
}: {
  onSaved: () => Promise<void>;
  documentId?: string;
  initialOperationsOpen?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"list" | "search">(
    documentId ? "search" : "list",
  );
  const [submitted, setSubmitted] = useState({
    q: "",
    mode: documentId ? ("search" as const) : ("list" as const),
    revision: 0,
  });
  const paging = useListPagination(
    "pdf",
    JSON.stringify([documentId, submitted.q, submitted.mode]),
  );
  const page = paging.page;
  const setPage = paging.setPage;
  const request = useRef<AbortController | null>(null);
  const [docs, setDocs] = useState<PdfDoc[]>([]);
  const [hits, setHits] = useState<Hit[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<PdfSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [ocrConfirmed, setOcrConfirmed] = useState<Record<string, boolean>>({});
  const savedRequests = useRef(new Map<string, string>());
  const load = useCallback(
    async (q: string, m: "list" | "search", p: number) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setBusy(true);
      setError("");
      setDocs([]);
      try {
        const params = new URLSearchParams({
          mode: m,
          q,
          page: String(p),
          limit: String(paging.size),
        });
        if (documentId) params.set("id", documentId);
        const response = await fetch("/api/pdf?" + params, {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok)
          throw Error(data.error ?? "PDF 서재를 읽지 못했습니다.");
        if (controller.signal.aborted) return;
        setSummary(data.summary);
        setDocs(data.documents ?? []);
        setHits(data.hits ?? []);
        setTotal(data.total ?? 0);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "PDF 검색에 실패했습니다.");
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    },
    [documentId, paging.size],
  );
  useEffect(() => {
    if (paging.ready && (!documentId || submitted.q))
      void load(submitted.q, submitted.mode, page);
    return () => request.current?.abort();
  }, [load, documentId, submitted, page, paging.ready]);
  async function save(hit: Hit) {
    const key = hit.documentId + ":" + hit.pageNumber;
    setSaving(key);
    setError("");
    const fingerprint = key + ":" + hit.signature + ":" + hit.quote;
    let requestId = savedRequests.current.get(fingerprint);
    if (!requestId) {
      requestId = crypto.randomUUID();
      savedRequests.current.set(fingerprint, requestId);
    }
    try {
      const response = await fetch("/api/pdf/citation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId,
          documentId: hit.documentId,
          pageNumber: hit.pageNumber,
          quote: hit.quote,
          signature: hit.signature,
          ocrConfirmed: Boolean(ocrConfirmed[fingerprint]),
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw Error(result.error ?? "인용 저장에 실패했습니다.");
      setMessage("원문 페이지와 함께 하이라이트를 저장했습니다.");
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setSaving(null);
    }
  }
  return (
    <section className="pdf-library">
      {!documentId && <PdfConnection />}
      <PcAccess id={documentId} />
      {!documentId && (
        <>
          <div className="section-heading">
            <div>
              <span className="eyebrow">PDF LIBRARY</span>
              <h2>원문을 찾고, 생각으로 이어가기</h2>
            </div>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => load(submitted.q, submitted.mode, page)}
            >
              <RefreshCw size={16} />
              상태 새로고침
            </button>
          </div>
          {summary && <PdfProgress summary={summary} />}
          <LibraryOperationsPanel initiallyOpen={initialOperationsOpen} />
        </>
      )}
      <form
        className="pdf-search"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(0);
          setSubmitted((s) => ({ q: query, mode, revision: s.revision + 1 }));
        }}
      >
        <label
          className="sr-only"
          htmlFor={documentId ? "book-pdf-query" : "pdf-query"}
        >
          PDF 검색어
        </label>
        <input
          id={documentId ? "book-pdf-query" : "pdf-query"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="예: 애착, 은혜, 상담 관계"
        />
        {!documentId && (
          <select
            aria-label="PDF 검색 범위"
            value={mode}
            onChange={(e) => setMode(e.target.value as "list" | "search")}
          >
            <option value="list">제목·폴더</option>
            <option value="search">원문 내용</option>
          </select>
        )}
        <button className="primary" disabled={busy}>
          <Search size={17} />
          {busy ? "찾는 중…" : "검색"}
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      <div className="pdf-results">
        {hits.map((hit, i) => (
          <article
            className="panel"
            key={hit.documentId + ":" + hit.pageNumber + ":" + i}
          >
            <h3>{hit.title}</h3>
            <p className="source-label">PDF {hit.pageNumber}페이지</p>
            {hit.status === "missing" && (
              <p>
                원본 연결이 끊겼습니다. 보존된 본문이며, 원문 확인·인용 저장에는
                외장하드가 필요합니다.
              </p>
            )}
            <blockquote>{hit.quote}</blockquote>
            {hit.extractionMethod?.startsWith("ocr_") && (
              <label className="ocr-confirmation">
                <input
                  type="checkbox"
                  checked={Boolean(
                    ocrConfirmed[
                      hit.documentId +
                        ":" +
                        hit.pageNumber +
                        ":" +
                        hit.signature +
                        ":" +
                        hit.quote
                    ],
                  )}
                  onChange={(e) =>
                    setOcrConfirmed((v) => ({
                      ...v,
                      [hit.documentId +
                      ":" +
                      hit.pageNumber +
                      ":" +
                      hit.signature +
                      ":" +
                      hit.quote]: e.target.checked,
                    }))
                  }
                />
                문자 인식 결과를 원문 페이지와 대조했습니다.
              </label>
            )}
            <div className="detail-actions">
              <a
                className="secondary"
                href={`/reader/${hit.documentId}?page=${hit.pageNumber}&signature=${encodeURIComponent(hit.signature)}`}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={16} />
                원문 페이지 열기
              </a>
              <button
                className="primary"
                disabled={
                  saving !== null ||
                  (Boolean(hit.extractionMethod?.startsWith("ocr_")) &&
                    !ocrConfirmed[
                      hit.documentId +
                        ":" +
                        hit.pageNumber +
                        ":" +
                        hit.signature +
                        ":" +
                        hit.quote
                    ])
                }
                onClick={() => save(hit)}
              >
                <Quote size={16} />
                {saving === hit.documentId + ":" + hit.pageNumber
                  ? "저장 중…"
                  : "하이라이트로 저장"}
              </button>
            </div>
          </article>
        ))}
      </div>
      {submitted.mode === "search" &&
        !busy &&
        submitted.q &&
        hits.length === 0 &&
        !error && (
          <div className="empty-state">
            현재 색인에서 일치하는 원문을 찾지 못했습니다. 다른 단어나 제목으로
            찾아보세요.
          </div>
        )}
      {!documentId && submitted.mode === "list" && (
        <>
          <p className="form-hint">
            {total.toLocaleString()}개 파일 · 파일명으로 등록한 제목은 서지 검증
            전입니다.
          </p>
          <PageSizeSelect label="PDF 목록" paging={paging} />
          <div className="pdf-list">
            {docs.map((doc) => (
              <article className="panel pdf-row" key={doc.id}>
                <FileText size={25} />
                <div>
                  <h3>{doc.title}</h3>
                  <details>
                    <summary>파일 위치</summary>
                    <p className="muted">{doc.relativePath}</p>
                  </details>
                  <p>
                    {doc.pageCount ? `${doc.pageCount}페이지 · ` : ""}
                    {stateNames[doc.status ?? ""] ?? "목록 등록됨"}
                  </p>
                </div>
                <a
                  className="secondary"
                  href={`/reader/${doc.id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  PDF 열기
                </a>
              </article>
            ))}
          </div>
          <PageNavigation
            label="PDF 목록"
            paging={paging}
            total={total}
            busy={busy || !!error}
          />
        </>
      )}
    </section>
  );
}
