"use client";
import { useEffect, useState } from "react";
import { pcDocumentUrl, pcLibraryUrl, privatePcOrigin } from "@/lib/pc-access";
export function PcAccess({
  id,
  page = 1,
  signature,
  operations = false,
}: {
  id?: string;
  page?: number;
  signature?: string;
  operations?: boolean;
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
  const onThisPc =
    !!origin &&
    typeof window !== "undefined" &&
    window.location.origin === origin;
  return (
    <aside className={operations ? "pc-access" : "panel"}>
      {origin && !onThisPc ? (
        <>
          <a
            href={
              id
                ? pcDocumentUrl(origin, id, page, signature)
                : pcLibraryUrl(origin, operations)
            }
            className={operations ? "secondary" : undefined}
            target="_blank"
            rel="noreferrer"
          >
            {id
              ? "내 PC의 서재에서 이 페이지 열기"
              : operations
                ? "PC 작업 현황 보기"
                : "PC의 PDF 원문 검색 열기"}
          </a>
        </>
      ) : (
        <p>
          {onThisPc
            ? "이 PC에서 PDF 원본에 연결할 수 없습니다. 외장하드 연결을 확인해 주세요."
            : "PDF 원본에 연결할 수 없습니다."}
        </p>
      )}
    </aside>
  );
}
