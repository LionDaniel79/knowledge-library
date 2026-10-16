"use client";
import { useEffect, useState } from "react";
import { pcDocumentUrl, privatePcOrigin } from "@/lib/pc-access";
export function PcAccess({
  id,
  page = 1,
  signature,
}: {
  id?: string;
  page?: number;
  signature?: string;
}) {
  const [state, setState] = useState<{
    local: boolean;
    pcOrigin: string | null;
  } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/pc-access", { cache: "no-store", signal: abort.signal })
      .then((r) => (r.ok ? r.json() : { local: false, pcOrigin: null }))
      .then(setState)
      .catch(() => {
        if (!abort.signal.aborted) setState({ local: false, pcOrigin: null });
      });
    return () => abort.abort();
  }, []);
  if (!state || state.local) return null;
  const origin = privatePcOrigin(state.pcOrigin ?? undefined);
  return (
    <aside className="panel">
      {origin ? (
        <>
          <a
            href={id ? pcDocumentUrl(origin, id, page, signature) : origin}
            target="_blank"
            rel="noreferrer"
          >
            내 PC의 서재에서 {id ? "이 페이지" : "PDF"} 열기
          </a>
        </>
      ) : (
        <p>PDF 원본에 연결할 수 없습니다.</p>
      )}
    </aside>
  );
}
