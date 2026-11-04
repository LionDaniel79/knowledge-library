"use client";
import { useEffect, useState } from "react";
type Book = {
  id: string;
  title: string;
  author: string;
  publisher?: string;
  edition?: string;
  publication_date?: string;
  version: number;
  candidates?: {
    isbn: string;
    publicationYear?: string;
    edition?: string;
    format?: string;
    facts: {
      title: string;
      author: string;
      publisher: string;
      coverUrl: string;
    };
  }[];
};
export default function LogosCoversPage() {
  const [items, setItems] = useState<Book[]>([]);
  const [offset, setOffset] = useState<number | null>(0);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [approved, setApproved] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function load(next: number) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/logos/covers?offset=" + next, {
        credentials: "same-origin",
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error ?? "목록을 가져오지 못했습니다.");
      setItems(data.items);
      setOffset(data.nextOffset);
      setApproved({});
      setUrls({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "조회 실패");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load(0);
  }, []);
  return (
    <main style={{ maxWidth: 960, margin: "3rem auto", padding: "1.5rem" }}>
      <h1>로고스 도서 표지 확인</h1>
      <p>
        <a href="/logos/import">로고스 가져오기 화면</a> ·{" "}
        <a href="/">나의 서재</a>
      </p>
      <p>
        로고스 XML에는 표지가 없습니다. 정확한 책·판본인지 직접 확인한 이미지
        주소만 등록하세요. 저장한 이미지는 서재에 보관됩니다. 기존 표지는
        덮어쓰지 않습니다.
      </p>
      {items.map((book) => (
        <section
          key={book.id}
          style={{ borderBottom: "1px solid #ddd", padding: "1rem 0" }}
        >
          <h3>{book.title}</h3>
          <p>{book.author}</p>
          <p>
            {[book.publisher, book.publication_date, book.edition]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {!!book.candidates?.length && (
            <fieldset>
              <legend>같은 판본인지 확인할 후보</legend>
              {book.candidates
                .filter((c) => c.facts.coverUrl)
                .map((candidate, index) => (
                  <label key={index} style={{ display: "block" }}>
                    <input
                      type="radio"
                      name={book.id}
                      checked={urls[book.id] === candidate.facts.coverUrl}
                      onChange={() => {
                        setUrls((old) => ({
                          ...old,
                          [book.id]: candidate.facts.coverUrl,
                        }));
                        setApproved((old) => ({ ...old, [book.id]: false }));
                      }}
                    />
                    {candidate.facts.title} · {candidate.facts.author} ·{" "}
                    {candidate.facts.publisher} · ISBN {candidate.isbn}
                    {[
                      candidate.publicationYear,
                      candidate.edition,
                      candidate.format === "digital"
                        ? "전자책"
                        : "자료 형태 확인 필요",
                    ]
                      .filter(Boolean)
                      .map((v) => " · " + v)
                      .join("")}
                  </label>
                ))}
            </fieldset>
          )}
          <label>
            확인된 표지 이미지 URL
            <input
              type="url"
              style={{ width: "100%" }}
              placeholder="https://..."
              value={urls[book.id] ?? ""}
              onChange={(e) =>
                setUrls((o) => ({ ...o, [book.id]: e.target.value }))
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={!!approved[book.id]}
              onChange={(e) =>
                setApproved((o) => ({ ...o, [book.id]: e.target.checked }))
              }
            />
            해당 책과 판본이 일치하는 표지임을 확인했습니다.
          </label>
          <button
            disabled={busy || !approved[book.id] || !urls[book.id]}
            onClick={async () => {
              setBusy(true);
              setError("");
              setNotice("");
              try {
                const r = await fetch("/api/logos/covers", {
                  method: "POST",
                  credentials: "same-origin",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    bookId: book.id,
                    expectedVersion: book.version,
                    coverUrl: urls[book.id],
                    verification: "manual",
                    origin: "user",
                  }),
                });
                const data = await r.json();
                if (!r.ok) throw Error(data.error ?? "표지 저장 실패");
                setItems((old) => old.filter((x) => x.id !== book.id));
                setNotice(book.title + " 표지 이미지를 저장했습니다.");
              } catch (e) {
                setError(e instanceof Error ? e.message : "표지 저장 실패");
              } finally {
                setBusy(false);
              }
            }}
          >
            표지 저장
          </button>
        </section>
      ))}
      {offset !== null && (
        <button disabled={busy} onClick={() => void load(offset)}>
          다음 50권
        </button>
      )}
      {!items.length && !busy && (
        <p>
          등록 가능한 표지 대기 도서가 없습니다. 5단계 로고스 실제 등록 이후
          확인할 수 있습니다.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" style={{ color: "crimson" }}>
          {error}
        </p>
      )}
    </main>
  );
}
