"use client";
import { useEffect, useRef, useState } from "react";
import { isbn13 } from "@/lib/bibliography";
import { type BookCandidate, catalogProviderNames } from "@/lib/book-lookup";
export function BookLookup({
  onSelect,
  preview,
  initialQuery = "",
}: {
  onSelect: (book: BookCandidate) => void;
  preview: boolean;
  initialQuery?: string;
}) {
  const [q, setQ] = useState(initialQuery),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [items, setItems] = useState<BookCandidate[]>([]),
    [camera, setCamera] = useState(false),
    [notice, setNotice] = useState("");
  const video = useRef<HTMLVideoElement>(null),
    pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function search(value = q) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setError("");
    setNotice("");
    setItems([]);
    if (preview) {
      setNotice("내 서재에서 책 정보를 검색할 수 있습니다.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/book-lookup?q=" + encodeURIComponent(value), {
          signal: controller.signal,
          cache: "no-store",
        }),
        data = await r.json();
      if (!r.ok) throw Error(data.error);
      setItems(data.items);
      setNotice(
        data.items.length
          ? (data.warnings ?? []).join(" ")
          : "검색 결과가 없습니다. ISBN이나 다른 제목으로 검색해 주세요.",
      );
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "검색 실패");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    if (!camera) return;
    let cancelled = false,
      stream: MediaStream | undefined,
      control: { stop: () => void } | undefined;
    void (async () => {
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        if (cancelled) return;
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const decoder = new BrowserMultiFormatReader();
        control = await decoder.decodeFromStream(
          stream,
          video.current!,
          (result, _error, controls) => {
            if (cancelled || !result) return;
            const isbn = isbn13(result.getText());
            if (!isbn) return;
            controls.stop();
            setCamera(false);
            setQ(isbn);
            void search(isbn);
          },
        );
        if (cancelled) control.stop();
      } catch {
        if (!cancelled) {
          setError(
            "카메라를 사용할 수 없습니다. 사진 선택이나 ISBN 입력을 이용해 주세요.",
          );
          setCamera(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      control?.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
    // A scan starts once when the user opens the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);
  async function photo(file?: File) {
    if (!file) return;
    setError("");
    if (file.size > 8 * 1024 * 1024) {
      setError("8MB 이하 바코드 사진을 선택해 주세요.");
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      const result = await new BrowserMultiFormatReader().decodeFromImageUrl(
        url,
      );
      const isbn = isbn13(result.getText());
      if (!isbn) throw Error("isbn");
      setQ(isbn);
      await search(isbn);
    } catch {
      setError(
        "책의 ISBN 바코드를 찾지 못했습니다. 숫자를 직접 입력할 수 있습니다.",
      );
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return (
    <section className="book-lookup" aria-label="책 정보 검색">
      <div className="lookup-line">
        <input
          aria-label="온라인 도서 검색어"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          maxLength={200}
          placeholder="책 제목 또는 ISBN"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void search();
            }
          }}
        />
        <button
          type="button"
          className="secondary"
          disabled={busy || q.trim().length < 2}
          onClick={() => void search()}
        >
          {busy ? "검색 중…" : "제목 검색"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setError("");
            setCamera((v) => !v);
          }}
        >
          {camera ? "스캔 닫기" : "바코드 스캔"}
        </button>
      </div>
      {camera && (
        <div className="barcode-camera">
          <video ref={video} autoPlay muted playsInline />
          <p>책 뒷면의 978·979로 시작하는 ISBN 바코드를 비춰 주세요.</p>
        </div>
      )}
      <label className="barcode-photo">
        바코드 이미지 등록
        <input
          type="file"
          accept="image/*"
          onChange={(e) => void photo(e.target.files?.[0])}
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="form-hint">
          {notice}
        </p>
      )}
      {!!items.length && (
        <div className="lookup-results">
          {items.map((b) => (
            <article key={b.id}>
              {b.coverUrl && <img src={b.coverUrl} alt="표지" loading="lazy" />}
              <div>
                <strong>{b.title}</strong>
                <p>
                  {b.author} · {b.publisher}
                </p>
                <small>
                  {b.isbn || "판본·ISBN 확인 필요"} ·{" "}
                  <a href={b.sourceUrl} target="_blank" rel="noreferrer">
                    {catalogProviderNames[b.provider]}
                  </a>
                </small>
              </div>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  onSelect(b);
                  setItems([]);
                  setNotice(
                    "정보를 채웠습니다. 판본을 확인한 뒤 저장해 주세요.",
                  );
                }}
              >
                선택
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
