"use client";
import { useState } from "react";
export function BookIntroduction({ id }: { id: string }) {
  const [data, setData] = useState<any>(null),
    [text, setText] = useState(""),
    [sources, setSources] = useState<
      { kind: string; url: string; excerpt: string }[]
    >([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [history, setHistory] = useState<any[] | null>(null);
  async function load() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/book-introduction?id=${id}`, {
          cache: "no-store",
        }),
        j = await r.json();
      if (!r.ok) throw Error(j.error);
      setData(j);
      setText(j.introduction?.text ?? "");
      setSources(j.introduction?.sources ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/book-introduction", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookId: id,
            bookVersion: data.bookVersion,
            expectedVersion: data.introduction?.version ?? 0,
            text,
            sources,
            requestId: crypto.randomUUID(),
          }),
        }),
        j = await r.json();
      if (!r.ok) throw Error(j.error);
      await load();
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open && !data && !busy) void load();
      }}
    >
      <summary>내가 정리한 도서 소개</summary>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {data && (
        <>
          <textarea
            aria-label="도서 소개"
            rows={5}
            value={text}
            maxLength={8000}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
          />
          <details>
            <summary>
              참고 자료 {data.references.length + sources.length}개
            </summary>
            {data.references.map((r: any) => (
              <article key={r.id}>
                <p>{r.value}</p>
                <a href={r.url} target="_blank" rel="noreferrer">
                  {r.provider}
                </a>
                <button
                  onClick={() =>
                    setSources((s) => [
                      ...s,
                      {
                        kind: "publisher",
                        url: r.url,
                        excerpt: String(r.value).slice(0, 500),
                      },
                    ])
                  }
                >
                  근거에 추가
                </button>
              </article>
            ))}
            {sources.map((s, i) => (
              <fieldset key={i}>
                <legend>참고 자료 {i + 1}</legend>
                <select
                  aria-label={`자료 유형 ${i + 1}`}
                  value={s.kind}
                  onChange={(e) =>
                    setSources((a) =>
                      a.map((v, k) =>
                        k === i ? { ...v, kind: e.target.value } : v,
                      ),
                    )
                  }
                >
                  <option value="review">확인한 리뷰</option>
                  <option value="publisher">출판사 소개</option>
                </select>
                <input
                  aria-label={`출처 주소 ${i + 1}`}
                  placeholder="https://…"
                  value={s.url}
                  onChange={(e) =>
                    setSources((a) =>
                      a.map((v, k) =>
                        k === i ? { ...v, url: e.target.value } : v,
                      ),
                    )
                  }
                />
                <textarea
                  aria-label={`발췌 ${i + 1}`}
                  placeholder="직접 확인한 짧은 발췌"
                  maxLength={500}
                  value={s.excerpt}
                  onChange={(e) =>
                    setSources((a) =>
                      a.map((v, k) =>
                        k === i ? { ...v, excerpt: e.target.value } : v,
                      ),
                    )
                  }
                />
                <button
                  onClick={() => setSources((a) => a.filter((_, k) => k !== i))}
                >
                  자료 제외
                </button>
              </fieldset>
            ))}
            <button
              disabled={sources.length >= 10}
              onClick={() =>
                setSources((s) => [
                  ...s,
                  { kind: "review", url: "", excerpt: "" },
                ])
              }
            >
              참고 자료 추가
            </button>
          </details>
          <button disabled={busy || !text.trim()} onClick={() => void save()}>
            소개 저장
          </button>
          {saved && <span role="status">저장했습니다.</span>}
          <button
            onClick={async () => {
              try {
                const r = await fetch(`/api/revisions/${id}`, {
                    cache: "no-store",
                  }),
                  j = await r.json();
                if (!r.ok) throw Error(j.error);
                setHistory(
                  (Array.isArray(j) ? j : (j.revisions ?? [])).filter(
                    (v: any) => v.action === "editIntroduction",
                  ),
                );
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            소개 수정 이력
          </button>
          {history && (
            <ul>
              {history.map((h: any) => (
                <li key={h.id}>
                  <time>
                    {new Date(h.createdAt ?? h.created_at).toLocaleString(
                      "ko-KR",
                    )}
                  </time>
                  <p>{(h.after ?? h.after_data)?.text}</p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {busy && <p role="status">불러오는 중…</p>}
    </details>
  );
}
