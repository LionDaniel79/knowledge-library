"use client";
import { useState } from "react";
import { parseLogosXmlSelection } from "@/lib/logos-xml";
import type { LogosRow } from "@/lib/logos-contract";
type Result = {
  received: number;
  alreadyImported: number;
  possibleExistingEdition: number;
  toCreate: number;
  permanent: number;
  temporary: number;
  needsReview: { resourceId: string; title: string }[];
};
export default function LogosImportPage() {
  const [rows, setRows] = useState<LogosRow[]>([]);
  const [totalInFile, setTotalInFile] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState<Result | null>(null);
  const permanent = rows.filter((x) => x.license === "permanent").length;
  const temporary = rows.filter((x) => x.license === "temporary").length;
  async function preview() {
    setBusy(true);
    setError("");
    setProgress(0);
    setSummary(null);
    const total: Result = {
      received: 0,
      alreadyImported: 0,
      possibleExistingEdition: 0,
      toCreate: 0,
      permanent: 0,
      temporary: 0,
      needsReview: [],
    };
    try {
      for (let n = 0; n < rows.length; n += 100) {
        const response = await fetch("/api/logos", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "preview",
            batch: { items: rows.slice(n, n + 100) },
          }),
        });
        const result = await response.json();
        if (!response.ok) throw Error(result.error ?? "가져오기 미리보기 실패");
        const part = result as Result;
        for (const key of [
          "received",
          "alreadyImported",
          "possibleExistingEdition",
          "toCreate",
          "permanent",
          "temporary",
        ] as const)
          total[key] += part[key];
        total.needsReview.push(
          ...part.needsReview.slice(
            0,
            Math.max(0, 20 - total.needsReview.length),
          ),
        );
        setProgress(Math.min(rows.length, n + 100));
      }
      setSummary(total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "검토 실패");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main style={{ maxWidth: 900, margin: "3rem auto", padding: "1.5rem" }}>
      <h1>로고스 전자책 등록 준비</h1>
      <p>
        Logos의 Excel 2003 XML 내보내기를 선택하세요. Resource Type이 성경 주석·단행본인 자료만 검토합니다. 이 화면은 서지 미리보기만
        수행하며 실제 도서를 등록하지 않습니다.
      </p>
      <p>
        <a href="/">나의 서재로 돌아가기</a> ·{" "}
        <a href="/logos/covers">로고스 표지 확인 화면</a>
      </p>
      <label>
        로고스 서재 XML{" "}
        <input
          type="file"
          accept=".xml,text/xml,application/xml"
          disabled={busy}
          onChange={async (e) => {
            setError("");
            setRows([]);
            setTotalInFile(0);
            setSummary(null);
            setProgress(0);
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              if (file.size > 8 * 1024 * 1024)
                throw Error("8MB 이하 XML 파일을 선택해 주세요.");
              const selection = parseLogosXmlSelection(await file.text());
              setRows(selection.items);
              setTotalInFile(selection.total);
            } catch (x) {
              setError(
                x instanceof Error ? x.message : "XML을 읽지 못했습니다.",
              );
            }
          }}
        />
      </label>
      {rows.length > 0 && (
        <section style={{ marginTop: 20 }}>
          <h2>파일 미리보기</h2>
          <p>
            원본 {totalInFile.toLocaleString()}건 · 등록 대상 {rows.length.toLocaleString()}건 · 제외 {(totalInFile - rows.length).toLocaleString()}건 · 영구 소유{" "}
            {permanent.toLocaleString()}건 · 임시 소유{" "}
            {temporary.toLocaleString()}건
          </p>
          <button disabled={busy} onClick={() => void preview()}>
            {busy ? "Neon 기존 도서와 비교 중…" : "서버 중복 후보 검토"}
          </button>
          {busy && (
            <p role="status">
              {progress.toLocaleString()} / {rows.length.toLocaleString()}건
              검토
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>제목</th>
                <th>저자</th>
                <th>소유</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 8).map((r) => (
                <tr key={r.resourceId}>
                  <td>{r.title}</td>
                  <td>{r.author}</td>
                  <td>{r.license === "permanent" ? "영구" : "임시/기타"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {summary && (
        <section aria-live="polite" style={{ marginTop: 24 }}>
          <h2>Neon 등록 전 검토 결과</h2>
          <p>
            신규 후보 {summary.toCreate}건 · 이미 등록 {summary.alreadyImported}
            건 · 기존 판본 검토 {summary.possibleExistingEdition}건
          </p>
          <p>
            같은 제목과 저자의 기존 도서를 자동 병합하지 않습니다. 사용자가
            확인한 판본만 다음 단계에서 등록합니다.
          </p>
          {summary.needsReview.length > 0 && (
            <ul>
              {summary.needsReview.map((x) => (
                <li key={x.resourceId}>
                  {x.title} ({x.resourceId})
                </li>
              ))}
            </ul>
          )}
          <p>
            <strong>실제 등록은 5단계에서 진행합니다.</strong> 현재 서버에는
            변경 사항이 없습니다.
          </p>
        </section>
      )}
      {error && (
        <p role="alert" style={{ color: "crimson" }}>
          {error}
        </p>
      )}
    </main>
  );
}
