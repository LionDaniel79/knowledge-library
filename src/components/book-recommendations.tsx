"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RefreshCw, Sparkles } from "lucide-react";
import { libraryRequest } from "@/client/replica/request";
import type { Book } from "@/lib/domain";
import { BookCover } from "./book-cover";

type RecommendationFormat = "paper" | "pdf" | "logos";
type Recommendation = {
  bookId: string;
  format: RecommendationFormat;
  reason: string;
};
type Snapshot = {
  recommendations: Recommendation[];
  books: Book[];
  updatedAt: string | null;
};
type ResponseData = Snapshot & {
  request?: {
    requestId?: string;
    id?: string;
    status: string;
    errorCode?: string;
  };
  error?: string;
};
const tabs = [
  { format: "paper", label: "종이책" },
  { format: "pdf", label: "PDF" },
  { format: "logos", label: "로고스" },
] as const;
const empty: Snapshot = { recommendations: [], books: [], updatedAt: null };
const pending = (status?: string) =>
  ["sending", "pending", "running"].includes(status ?? "");

function snapshot(value: unknown): Snapshot | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<Snapshot>;
  if (
    !Array.isArray(v.recommendations) ||
    !Array.isArray(v.books) ||
    (v.updatedAt !== null && typeof v.updatedAt !== "string")
  )
    return null;
  const books = v.books.filter(
    (b): b is Book =>
      !!b &&
      typeof b.id === "string" &&
      typeof b.title === "string" &&
      Array.isArray(b.formats) &&
      Array.isArray(b.tags),
  );
  const recommendations = v.recommendations.filter(
    (r) =>
      !!r &&
      typeof r.bookId === "string" &&
      typeof r.reason === "string" &&
      tabs.some((t) => t.format === r.format) &&
      books.some((b) => b.id === r.bookId),
  );
  return { books, recommendations, updatedAt: v.updatedAt };
}

export function BookRecommendations(props: {
  ownerId: string;
  revision?: unknown;
  onOpenBook: (id: string) => void;
}) {
  // A different signed-in owner must never briefly see the previous owner's cache.
  return <OwnerRecommendations key={props.ownerId} {...props} />;
}
function OwnerRecommendations({
  ownerId,
  revision,
  onOpenBook,
}: {
  ownerId: string;
  revision?: unknown;
  onOpenBook: (id: string) => void;
}) {
  const id = useId();
  const cacheKey = ownerId
    ? `library:book-recommendations:v1:${encodeURIComponent(ownerId)}`
    : "";
  const [saved, setSaved] = useState<Snapshot>(empty);
  const [format, setFormat] = useState<RecommendationFormat>("paper");
  const [indices, setIndices] = useState({ paper: 0, pdf: 0, logos: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const requestId = useRef<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingStarted = useRef(0);
  const mounted = useRef(true);
  const lastRevision = useRef(revision);
  const swipe = useRef<{
    x: number;
    y: number;
    kind: "touch" | "mouse";
  } | null>(null);
  const swiped = useRef(false);

  function rememberRequest(value: string | null) {
    requestId.current = value;
    if (!cacheKey) return;
    try {
      if (value) localStorage.setItem(cacheKey + ":request", value);
      else localStorage.removeItem(cacheKey + ":request");
    } catch {}
  }
  function finish() {
    lock.current = false;
    setBusy(false);
    setLoading(false);
  }
  function fail(message: string) {
    setError(message);
    finish();
  }
  function apply(value: ResponseData, isPending = false) {
    const confirmed = snapshot(value);
    if (!confirmed)
      throw Error("추천 정보를 확인하지 못했습니다. 다시 시도해 주세요.");
    const status = value.request?.status;
    const terminalSuccess = !isPending && (!status || status === "succeeded");
    // The last successful snapshot remains authoritative even if a newer request
    // failed. Its timestamp also distinguishes a filtered empty snapshot from a
    // response with no confirmed result available.
    if (
      terminalSuccess ||
      confirmed.updatedAt ||
      confirmed.recommendations.length > 0
    ) {
      setSaved(confirmed);
      if (cacheKey) {
        try {
          localStorage.setItem(cacheKey, JSON.stringify(confirmed));
        } catch {}
      }
    }
    if (value.request?.requestId || value.request?.id)
      rememberRequest(value.request.requestId ?? value.request.id ?? null);
    if (pending(status) || isPending) {
      lock.current = true;
      setBusy(true);
      setLoading(false);
      if (!pollingStarted.current) pollingStarted.current = Date.now();
      if (Date.now() - pollingStarted.current > 90000) {
        fail(
          "추천 처리 상태를 확인하지 못했습니다. 저장된 추천은 그대로 유지됩니다. 다시 눌러 상태를 확인해 주세요.",
        );
        return;
      }
      poll.current = setTimeout(() => {
        void read();
      }, 2000);
      return;
    }
    if (status === "failed" || status === "unknown") {
      rememberRequest(null);
      fail(
        status === "unknown"
          ? "이전 추천 요청의 결과를 확인하지 못해 비용 한도에서 예약 금액을 유지합니다. 저장된 추천은 그대로입니다. 다시 누르면 새 추천을 요청합니다."
          : "새 추천을 만들지 못했습니다. 저장된 추천은 그대로 유지됩니다. 다시 시도해 주세요.",
      );
      return;
    }
    rememberRequest(null);
    setError("");
    finish();
  }
  async function load(method: "GET" | "POST") {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const timeout = setTimeout(() => controller.abort(), 65000);
    try {
      const response = await libraryRequest(
        "/api/book-recommendations",
        {
          method,
          cache: "no-store",
          signal: controller.signal,
          ...(method === "POST"
            ? {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ requestId: requestId.current }),
              }
            : {}),
        },
        { preferServer: true },
      );
      const value = (await response.json()) as ResponseData;
      if (!response.ok)
        throw Error(
          value.error || "추천을 불러오지 못했습니다. 다시 시도해 주세요.",
        );
      if (mounted.current && active.current === controller)
        apply(value, response.status === 202);
    } catch (e) {
      if (mounted.current && active.current === controller)
        fail(
          e instanceof TypeError
            ? "연결을 확인한 뒤 다시 시도해 주세요. 저장된 추천은 그대로 유지됩니다."
            : e instanceof Error && e.name !== "AbortError"
              ? e.message
              : "연결이 지연되고 있습니다. 저장된 추천은 그대로 유지됩니다. 다시 시도해 주세요.",
        );
    } finally {
      clearTimeout(timeout);
    }
  }
  async function read() {
    await load("GET");
  }
  useEffect(() => {
    mounted.current = true;
    if (cacheKey) {
      try {
        const cached = snapshot(
          JSON.parse(localStorage.getItem(cacheKey) || "null"),
        );
        if (cached) setSaved(cached);
        const previousId = localStorage.getItem(cacheKey + ":request");
        if (previousId && /^[\da-f-]{36}$/i.test(previousId))
          requestId.current = previousId;
      } catch {}
    }
    if (ownerId) void read();
    else setLoading(false);
    return () => {
      mounted.current = false;
      active.current?.abort();
      if (poll.current) clearTimeout(poll.current);
    };
    // Owner changes remount this component. Loading never creates an AI request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);
  useEffect(() => {
    if (lastRevision.current === revision) return;
    lastRevision.current = revision;
    if (ownerId && !lock.current) void read();
    // Persisted library changes only recheck the saved result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, ownerId]);
  function refresh() {
    if (!ownerId || lock.current || loading) return;
    lock.current = true;
    setBusy(true);
    setError("");
    pollingStarted.current = 0;
    if (poll.current) clearTimeout(poll.current);
    if (!requestId.current) rememberRequest(crypto.randomUUID());
    void load("POST");
  }
  const items = saved.recommendations.filter((r) => r.format === format);
  const index = items.length ? indices[format] % items.length : 0;
  const recommendation = items[index];
  const book =
    recommendation && saved.books.find((b) => b.id === recommendation.bookId);
  function move(step: number) {
    if (items.length < 2) return;
    setIndices((previous) => ({
      ...previous,
      [format]: (index + step + items.length) % items.length,
    }));
  }
  function endSwipe(x: number, y: number, kind: "touch" | "mouse") {
    const start = swipe.current;
    swipe.current = null;
    if (
      !start ||
      start.kind !== kind ||
      Math.abs(x - start.x) < 45 ||
      Math.abs(x - start.x) <= Math.abs(y - start.y)
    )
      return;
    swiped.current = true;
    move(x < start.x ? 1 : -1);
  }
  const hasSaved = !!saved.updatedAt || saved.recommendations.length > 0;
  return (
    <section
      className="panel book-recommendations"
      aria-labelledby={`${id}-title`}
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">FROM YOUR LIBRARY</span>
          <h2 id={`${id}-title`}>AI가 추천하는 나의 책</h2>
        </div>
        <Sparkles size={20} aria-hidden="true" />
      </div>
      <p className="recommendation-intro">
        내가 소장한 책에서 다음에 읽을 책을 골라 보세요.
      </p>
      <div
        className="recommendation-tabs"
        role="tablist"
        aria-label="추천 도서 형식"
      >
        {tabs.map((tab, tabIndex) => (
          <button
            type="button"
            key={tab.format}
            id={`${id}-${tab.format}-tab`}
            role="tab"
            aria-selected={format === tab.format}
            aria-controls={`${id}-panel`}
            tabIndex={format === tab.format ? 0 : -1}
            onClick={() => setFormat(tab.format)}
            onKeyDown={(e) => {
              const next =
                e.key === "ArrowRight"
                  ? (tabIndex + 1) % tabs.length
                  : e.key === "ArrowLeft"
                    ? (tabIndex + tabs.length - 1) % tabs.length
                    : e.key === "Home"
                      ? 0
                      : e.key === "End"
                        ? tabs.length - 1
                        : -1;
              if (next < 0) return;
              e.preventDefault();
              setFormat(tabs[next].format);
              document
                .getElementById(`${id}-${tabs[next].format}-tab`)
                ?.focus();
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${format}-tab`}
      >
        <div
          className="recommendation-carousel"
          role="group"
          aria-label="추천 책 넘기기"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              move(e.key === "ArrowRight" ? 1 : -1);
            }
          }}
          onTouchStart={(e) => {
            const t = e.touches[0];
            swiped.current = false;
            swipe.current = { x: t.clientX, y: t.clientY, kind: "touch" };
          }}
          onTouchEnd={(e) => {
            const t = e.changedTouches[0];
            if (t) endSwipe(t.clientX, t.clientY, "touch");
          }}
          onTouchCancel={() => {
            swipe.current = null;
          }}
          onPointerDown={(e) => {
            if (e.pointerType !== "mouse" || e.button !== 0) return;
            swiped.current = false;
            swipe.current = { x: e.clientX, y: e.clientY, kind: "mouse" };
          }}
          onPointerUp={(e) => {
            if (e.pointerType === "mouse")
              endSwipe(e.clientX, e.clientY, "mouse");
          }}
          onPointerLeave={() => {
            if (swipe.current?.kind === "mouse") swipe.current = null;
          }}
          onClickCapture={(e) => {
            if (swiped.current) {
              e.preventDefault();
              e.stopPropagation();
              swiped.current = false;
            }
          }}
        >
          {book ? (
            <article
              className="recommendation-book"
              key={`${format}-${book.id}`}
            >
              <button
                className="recommendation-book-link"
                type="button"
                aria-label={`${book.title} 상세 보기`}
                onClick={() => onOpenBook(book.id)}
                onDragStart={(e) => e.preventDefault()}
              >
                <BookCover book={book} />
                <h3>{book.title}</h3>
                <p>{book.author || "저자 미입력"}</p>
                <p className="recommendation-reason">{recommendation.reason}</p>
              </button>
            </article>
          ) : (
            <div className="recommendation-empty">
              <Sparkles size={42} aria-hidden="true" />
              <p>
                {loading
                  ? "저장된 추천을 불러오는 중…"
                  : hasSaved
                    ? "이 형식의 추천 책이 없습니다."
                    : !ownerId
                      ? "로그인하면 내 소장 도서에서 추천을 받을 수 있어요."
                      : "추천받기를 누르면 소장 도서에서 책을 골라 드려요."}
              </p>
            </div>
          )}
        </div>
        {items.length > 0 && (
          <div className="recommendation-navigation">
            <button
              className="icon-button"
              type="button"
              aria-label="이전 추천 책"
              disabled={items.length < 2}
              onClick={() => move(-1)}
            >
              <ArrowLeft size={17} />
            </button>
            <span aria-live="polite">
              {index + 1} / {items.length}
            </span>
            <button
              className="icon-button"
              type="button"
              aria-label="다음 추천 책"
              disabled={items.length < 2}
              onClick={() => move(1)}
            >
              <ArrowRight size={17} />
            </button>
          </div>
        )}
      </div>
      <p className="recommendation-basis">
        제목·저자·분류 등 등록된 정보에 근거한 추천이며, 책 본문을 확인한 내용은
        아닙니다.
      </p>
      {saved.updatedAt && (
        <p className="recommendation-date">
          마지막 추천{" "}
          <time dateTime={saved.updatedAt}>
            {new Date(saved.updatedAt).toLocaleDateString("ko-KR")}
          </time>
        </p>
      )}
      {error && (
        <p className="recommendation-error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p className="recommendation-status" role="status">
          소장 도서에서 추천을 고르고 있어요. 잠시 기다려 주세요.
        </p>
      )}
      <button
        type="button"
        className="secondary recommendation-refresh"
        disabled={!ownerId || busy || loading}
        onClick={refresh}
      >
        <RefreshCw size={15} aria-hidden="true" />
        {busy ? "추천 중…" : hasSaved ? "새로고침" : "추천받기"}
      </button>
    </section>
  );
}
