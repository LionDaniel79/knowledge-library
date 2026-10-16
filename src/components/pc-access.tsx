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
      .then((r) => (r.ok ? r.json() : null))
      .then(setState)
      .catch(() => {});
    return () => abort.abort();
  }, []);
  if (!state || state.local) return null;
  const origin = privatePcOrigin(state.pcOrigin ?? undefined);
  return (
    <aside className="panel">
      <p>
        현재 접속한 서버에는 PDF 원본이 없습니다. 책 목록·메모·저장된 목차는
        계속 사용할 수 있습니다.
      </p>
      {origin ? (
        <>
          <a
            href={id ? pcDocumentUrl(origin, id, page, signature) : origin}
            target="_blank"
            rel="noreferrer"
          >
            내 PC의 서재에서 {id ? "이 페이지" : "PDF"} 열기
          </a>
          <p>
            PC와 외장하드가 연결되어 있고, 이 기기가 같은 비공개 네트워크에
            접속해야 합니다. PC 서재에서도 Google 로그인이 필요합니다.
          </p>
        </>
      ) : (
        <p>외부 PDF 접근은 비공개 PC 연결을 설정한 뒤 사용할 수 있습니다.</p>
      )}
    </aside>
  );
}
