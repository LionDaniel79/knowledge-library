"use client";
import { useState, useRef } from "react";
import type { Book } from "@/lib/domain";
import { ZoteroSyncPanel } from "./zotero-sync-panel";
type Link = {
  id: string;
  url: string;
  state: string;
  version: number;
  snapshot: { remoteVerified?: boolean };
};
export function ZoteroLinks({ book }: { book: Book }) {
  const [syncOpen, setSyncOpen] = useState(false);
  const [links, setLinks] = useState<Link[] | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [url, setUrl] = useState("");
  const requests = useRef(new Map<string, string>());
  async function load() {
    const r = await fetch("/api/zotero-links?bookId=" + book.id, {
      cache: "no-store",
    });
    const j = await r.json();
    if (!r.ok) throw Error(j.error ?? "연결을 읽지 못했습니다.");
    setLinks(j);
  }
  async function save(url: string, state: string, expectedVersion: number) {
    setBusy(true);
    setError("");
    const payload = {
        bookId: book.id,
        expectedBookVersion: book.version,
        url,
        state,
        expectedVersion,
      },
      key = JSON.stringify(payload),
      requestId = requests.current.get(key) ?? crypto.randomUUID();
    requests.current.set(key, requestId);
    try {
      const r = await fetch("/api/knowledge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId, type: "linkZotero", payload }),
        }),
        j = await r.json();
      if (!r.ok) {
        if (r.status < 500) requests.current.delete(key);
        throw Error(j.error ?? "연결을 저장하지 못했습니다.");
      }
      requests.current.delete(key);
      await load();
      setUrl("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="curation-details"
      onToggle={(e) => {
        if (e.target === e.currentTarget && e.currentTarget.open && !links)
          void load().catch((e) => setError(e.message));
      }}
    >
      <summary>Zotero·서지 내보내기</summary>
      <button onClick={() => setSyncOpen(true)}>Zotero 전송·갱신</button>
      {syncOpen && (
        <ZoteroSyncPanel
          book={book}
          onClose={() => setSyncOpen(false)}
          onSynced={() => void load().catch((e) => setError(e.message))}
        />
      )}
      <p>
        서지 파일을 내려받아 Zotero의 ‘파일 → 가져오기’에서 열 수 있습니다. 이
        단계는 서지를 복사하며, PDF 원문이나 개인 메모를 보내지 않습니다.
      </p>
      <p>
        <a href={`/api/bibliography?bookId=${book.id}&format=csl`}>CSL JSON</a>{" "}
        · <a href={`/api/bibliography?bookId=${book.id}&format=ris`}>RIS</a>
      </p>
      <p className="form-hint">
        저자명이 한 줄로 저장된 자료는 원문 표기를 그대로 옮깁니다. Zotero에서
        저자 구분·출판 연도·자료 유형을 확인해 주세요.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {links?.map((l) => (
        <p key={l.id}>
          <a href={l.url} target="_blank" rel="noreferrer">
            Zotero 항목 열기
          </a>{" "}
          ·{" "}
          {l.state === "active"
            ? l.snapshot.remoteVerified
              ? "전송 확인됨"
              : "직접 연결함"
            : "연결 해제됨"}{" "}
          <button
            disabled={busy}
            onClick={() =>
              void save(
                l.url,
                l.state === "active" ? "removed" : "active",
                l.version,
              )
            }
          >
            {l.state === "active" ? "연결 해제" : "다시 연결"}
          </button>
        </p>
      ))}
      <details>
        <summary>이미 있는 Zotero 항목 연결</summary>
        <p>
          본인 Zotero 서재의 항목 링크를 저장합니다. 원격 서지를 읽거나 덮어쓰는
          자동 동기화는 수행하지 않습니다.
        </p>
        <form
          className="knowledge-controls"
          onSubmit={(e) => {
            e.preventDefault();
            void save(url, "active", 0);
          }}
        >
          <label>
            Zotero 항목의 HTTPS 링크
            <input
              type="url"
              required
              maxLength={500}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.zotero.org/users/123/items/ABCD1234"
            />
          </label>
          <button disabled={busy}>이 책에 연결</button>
        </form>
      </details>
    </details>
  );
}
