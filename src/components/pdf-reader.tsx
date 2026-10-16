"use client";
import { useEffect, useState } from "react";
import { PcAccess } from "./pc-access";
export function PdfReader({
  id,
  title,
  initialPage,
  signature,
}: {
  id: string;
  title: string;
  initialPage: number;
  signature?: string;
}) {
  const [page, setPage] = useState(initialPage),
    [count, setCount] = useState<number | null>(null),
    [image, setImage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true),
    [toc, setToc] = useState<{ title: string; page: number | null }[]>([]);
  const pin = signature ? `&signature=${encodeURIComponent(signature)}` : "";
  useEffect(() => {
    const abort = new AbortController();
    fetch(`/api/pdf?mode=detail&id=${id}`, { signal: abort.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setCount(d.pageCount ?? null);
          try {
            setToc(JSON.parse(d.toc ?? "[]"));
          } catch {}
        }
      })
      .catch(() => {});
    return () => abort.abort();
  }, [id]);
  useEffect(() => {
    const abort = new AbortController();
    let objectUrl = "";
    setBusy(true);
    setError("");
    setImage("");
    fetch(`/api/pdf/${id}/page?page=${page}${pin}`, { signal: abort.signal })
      .then(async (r) => {
        if (!r.ok) {
          const d = await r.json();
          throw Error(d.error ?? "페이지를 열지 못했습니다.");
        }
        const blob = await r.blob();
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setImage(objectUrl);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, page, pin]);
  return (
    <main className="reader">
      <PcAccess id={id} page={page} signature={signature} />
      <header>
        <a href="/">← 서재로</a>
        <h1>{title}</h1>
        <p>
          PDF {page}페이지{count ? ` / ${count}페이지` : ""} · 인쇄된 쪽수와
          다를 수 있습니다.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPage(Number(new FormData(e.currentTarget).get("page")));
          }}
        >
          <button
            type="button"
            disabled={page <= 1 || busy}
            onClick={() => setPage(page - 1)}
          >
            이전
          </button>
          <label>
            PDF 페이지
            <input
              key={page}
              name="page"
              type="number"
              min="1"
              max={count ?? 100000}
              defaultValue={page}
              required
            />
          </label>
          <button disabled={busy}>이동</button>
          <button
            type="button"
            disabled={busy || Boolean(count && page >= count)}
            onClick={() => setPage(page + 1)}
          >
            다음
          </button>
          <a
            href={`/api/pdf/${id}/file?${pin.slice(1)}#page=${page}`}
            target="_blank"
            rel="noreferrer"
          >
            PDF 파일 열기
          </a>
        </form>
      </header>
      {toc.length > 0 && (
        <details>
          <summary>목차</summary>
          {toc
            .filter((t) => t.page)
            .map((t, i) => (
              <button key={i} onClick={() => setPage(t.page!)}>
                {t.title} · {t.page}
              </button>
            ))}
        </details>
      )}
      {busy && <p role="status">원문 페이지를 여는 중입니다…</p>}
      {error && <p role="alert">{error}</p>}
      {image && (
        <img
          src={image}
          alt={`${title} 원문 PDF ${page}페이지`}
          className="pdf-page-image"
        />
      )}
    </main>
  );
}
