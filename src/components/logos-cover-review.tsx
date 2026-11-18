"use client";
import { useEffect, useState, useRef } from "react";
type Book = {
  id: string;
  title: string;
  author: string;
  publisher?: string;
  edition?: string;
  publication_date?: string;
  version: number;
  candidates?: {
    provider?: string;
    url?: string;
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
export function LogosCoverReview({
  embedded = false,
  onBusy,
  onChanged,
}: {
  embedded?: boolean;
  onBusy?: (busy: boolean) => void;
  onChanged?: () => Promise<void>;
}) {
  const [items, setItems] = useState<Book[]>([]);
  const [offset, setOffset] = useState<number | null>(0);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [batchBusy, setBatchBusy] = useState(false);
  const pending = useRef(new Set<string>()),
    bulkPending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [imageErrors, setImageErrors] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function load(next: number) {
    if (bulkPending.current || pending.current.size) return;
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
      setUrls({});
      setSelected({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "조회 실패");
    } finally {
      setBusy(false);
    }
  }
  async function saveCover(
    book: Book,
    action: "save" | "reject" = "save",
    notify = true,
  ) {
    if (pending.current.has(book.id)) return false;
    pending.current.add(book.id);
    setSaving((o) => ({ ...o, [book.id]: true }));
    setErrors((o) => ({ ...o, [book.id]: "" }));
    setNotice("");
    try {
      const body =
        action === "reject"
          ? { action: "reject", bookId: book.id, expectedVersion: book.version }
          : {
              bookId: book.id,
              expectedVersion: book.version,
              coverUrl: urls[book.id]?.trim(),
              verification: "manual",
              origin: "user",
            };
      const r = await fetch("/api/logos/covers", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error ?? "표지 처리 실패");
      setItems((old) => old.filter((x) => x.id !== book.id));
      setSelected((old) => {
        const next = { ...old };
        delete next[book.id];
        return next;
      });
      setOffset((old) => (old === null ? null : Math.max(0, old - 1)));
      setNotice(
        book.title +
          (action === "reject"
            ? " 표지 후보를 거절했습니다."
            : " 표지 이미지를 저장했습니다."),
      );
      if (notify) void onChanged?.().catch(() => {});
      return true;
    } catch (e) {
      setErrors((o) => ({
        ...o,
        [book.id]: e instanceof Error ? e.message : "표지 처리 실패",
      }));
      return false;
    } finally {
      pending.current.delete(book.id);
      setSaving((o) => ({ ...o, [book.id]: false }));
    }
  }
  async function saveSelected() {
    if (bulkPending.current || pending.current.size) return;
    const books = items.filter((b) => selected[b.id]);
    if (!books.length) return;
    if (books.some((b) => !urls[b.id]?.trim())) {
      setError(
        "선택한 책마다 표지 후보를 선택하거나 이미지 주소를 입력해 주세요.",
      );
      return;
    }
    bulkPending.current = true;
    setBatchBusy(true);
    setError("");
    let saved = 0;
    try {
      for (const book of books)
        if (await saveCover(book, "save", false)) saved++;
      if (saved) void onChanged?.().catch(() => {});
      setNotice(
        `표지 저장 ${saved}권 · 실패 ${books.length - saved}권. 실패한 책은 선택 상태로 남아 있습니다.`,
      );
    } finally {
      bulkPending.current = false;
      setBatchBusy(false);
    }
  }
  useEffect(() => {
    onBusy?.(batchBusy || Object.values(saving).some(Boolean));
  }, [batchBusy, saving, onBusy]);
  useEffect(() => {
    void load(0);
  }, []);
  const savingAny = Object.values(saving).some(Boolean);
  const Container = embedded ? "section" : "main";
  return (
    <Container
      className={embedded ? "logos-cover-embedded" : undefined}
      style={
        embedded
          ? undefined
          : { maxWidth: 960, margin: "3rem auto", padding: "1.5rem" }
      }
    >
      {!embedded && (
        <>
          <h1>로고스 도서 표지 확인</h1>
          <nav className="compact-page-nav" aria-label="로고스 관련 화면">
            <a className="secondary compact-link" href="/logos/import">
              로고스 가져오기 화면
            </a>
            <a className="secondary compact-link" href="/">
              나의 서재
            </a>
          </nav>
          <p>
            로고스 XML에는 표지가 없습니다. 정확한 책·판본인지 직접 확인한
            이미지 주소만 등록하세요. 저장한 이미지는 서재에 보관됩니다. 기존
            표지는 덮어쓰지 않습니다.
          </p>
        </>
      )}
      {!!items.length && (
        <div className="logos-cover-bulk">
          <label>
            <input
              type="checkbox"
              aria-label="현재 목록 전체 선택"
              disabled={busy || batchBusy || savingAny}
              checked={items.every((b) => !!selected[b.id])}
              ref={(el) => {
                if (el)
                  el.indeterminate =
                    items.some((b) => selected[b.id]) &&
                    !items.every((b) => selected[b.id]);
              }}
              onChange={(e) =>
                setSelected(
                  Object.fromEntries(
                    items.map((b) => [b.id, e.target.checked]),
                  ),
                )
              }
            />{" "}
            전체 선택
          </label>
          <button
            className="primary compact-link"
            disabled={
              busy ||
              batchBusy ||
              savingAny ||
              !items.some((b) => selected[b.id])
            }
            onClick={() => void saveSelected()}
          >
            {batchBusy
              ? "일괄 저장 중…"
              : `선택 표지 저장 (${items.filter((b) => selected[b.id]).length}권)`}
          </button>
          <span>
            각 책의 후보를 선택하거나 이미지 주소를 입력한 뒤 저장하세요.
          </span>
        </div>
      )}
      {items.map((book) => (
        <section key={book.id} className="logos-cover-card">
          <div className="logos-cover-heading">
            <input
              type="checkbox"
              id={"select-" + book.id}
              aria-label={book.title + " 선택"}
              disabled={busy || batchBusy || saving[book.id]}
              checked={!!selected[book.id]}
              onChange={(e) =>
                setSelected((o) => ({ ...o, [book.id]: e.target.checked }))
              }
            />
            <h3>
              <label htmlFor={"select-" + book.id}>{book.title}</label>
            </h3>
          </div>
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
                  <label key={index} className="logos-cover-candidate">
                    <span>
                      {candidate.facts.coverUrl.startsWith("https://") && (
                        <img
                          src={candidate.facts.coverUrl}
                          alt={candidate.facts.title + " 표지 후보"}
                          width={60}
                          height={84}
                          style={{ objectFit: "contain" }}
                          onError={() =>
                            setImageErrors((old) => ({
                              ...old,
                              [candidate.facts.coverUrl]: true,
                            }))
                          }
                        />
                      )}
                      {imageErrors[candidate.facts.coverUrl] && (
                        <span role="alert">
                          미리보기 이미지를 불러오지 못했습니다. 다른 후보를
                          선택할 수 있습니다.
                        </span>
                      )}
                    </span>
                    <span className="logos-cover-candidate-info">
                      <input
                        type="radio"
                        style={{ width: 16 }}
                        disabled={batchBusy || saving[book.id]}
                        name={book.id}
                        checked={urls[book.id] === candidate.facts.coverUrl}
                        onChange={() => {
                          setUrls((old) => ({
                            ...old,
                            [book.id]: candidate.facts.coverUrl,
                          }));
                          setErrors((old) => ({ ...old, [book.id]: "" }));
                        }}
                      />
                      {candidate.facts.title} · {candidate.facts.author} ·{" "}
                      {candidate.facts.publisher} · ISBN {candidate.isbn}
                      {candidate.url?.startsWith("https://") && (
                        <a
                          href={candidate.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {" "}
                          · {candidate.provider ?? "출처 확인"}
                        </a>
                      )}
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
                    </span>
                  </label>
                ))}
            </fieldset>
          )}
          <label>
            확인된 표지 이미지 URL
            <input
              type="url"
              disabled={batchBusy || saving[book.id]}
              style={{ width: "100%" }}
              placeholder="https://..."
              value={urls[book.id] ?? ""}
              onChange={(e) => {
                setUrls((o) => ({ ...o, [book.id]: e.target.value }));
                setErrors((o) => ({ ...o, [book.id]: "" }));
              }}
            />
          </label>
          <div className="compact-page-nav">
            <button
              className="primary compact-link"
              disabled={
                busy || batchBusy || saving[book.id] || !urls[book.id]?.trim()
              }
              onClick={() => void saveCover(book)}
            >
              {saving[book.id] ? "저장 중…" : "표지 저장"}
            </button>
            <button
              className="secondary compact-link"
              disabled={busy || batchBusy || saving[book.id]}
              onClick={() => void saveCover(book, "reject")}
            >
              거절
            </button>
          </div>
          {errors[book.id] && (
            <p role="alert" style={{ color: "crimson" }}>
              {errors[book.id]}
            </p>
          )}
        </section>
      ))}
      {offset !== null && (
        <button
          className="secondary compact-link"
          disabled={busy || batchBusy || savingAny}
          onClick={() => void load(offset)}
        >
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
    </Container>
  );
}
