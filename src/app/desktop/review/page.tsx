"use client";
import { useEffect, useState } from "react";

type Manifest = {
  id: string;
  operationId: string;
  status: "collecting" | "sealed";
  christianFiles: number;
  generalFiles: number;
  expectedDocuments: number;
  createdAt: string;
  sealedAt: string | null;
};
type Preview = {
  selectedDocuments: number;
  missing: number;
  versionConflicts: number;
  manualExclusions: number;
  scopeExclusions: number;
  deleteCandidates: number;
  archiveBooks: number;
  archiveDocuments: number;
  warning: string;
  relatedRecords: Record<string, number>;
  indirectJsonReferencesReviewed: false;
  backupVerified: false;
  syncVerified: false;
  deleteAuthorized: false;
};

export default function DesktopReviewPage() {
  const [manifests, setManifests] = useState<Manifest[]>([]);
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/desktop/catalog/review", { credentials: "same-origin" })
      .then(async (response) => {
        const value = await response.json();
        if (!response.ok)
          throw Error(value.error ?? "목록 조회에 실패했습니다.");
        return value as { manifests: Manifest[] };
      })
      .then(({ manifests }) => {
        if (active) setManifests(manifests);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "조회 실패");
      });
    return () => {
      active = false;
    };
  }, []);

  async function inspect(id: string) {
    setSelected(id);
    setPreview(null);
    setError("");
    setLoading(true);
    try {
      const response = await fetch("/api/desktop/catalog/review", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manifestId: id }),
      });
      const value = await response.json();
      if (!response.ok) throw Error(value.error ?? "검토에 실패했습니다.");
      setPreview(value as Preview);
    } catch (e) {
      setError(e instanceof Error ? e.message : "검토 실패");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 920, margin: "3rem auto", padding: "1.5rem" }}>
      <h1>Windows PDF 폴더 동기화·보관·재등록 검토</h1>
      <p>
        <a href="/desktop/connect">Windows 연결 설정</a> ·{" "}
        <a href="/">나의 서재</a>
      </p>
      <p>
        이 화면은 서버의 선택 목록과 참조 건수를 읽기만 합니다.
        PDF·메모·도서·OCR을 수정하거나 삭제하지 않습니다.
      </p>
      <p>
        보관 대상 수는 삭제 승인 수가 아닙니다. 기존 문서와 OCR은 보존합니다.
        백업 복원·기기 동기화·간접 참조는 5단계에서 별도 확인합니다.
      </p>
      {manifests.length === 0 && !error && (
        <p>
          아직 서버에 제출된 검토 목록이 없습니다. 3단계 Windows 검수판의 로컬
          모의 전송은 이 목록에 나타나지 않습니다.
        </p>
      )}
      <ul>
        {manifests.map((m) => (
          <li key={m.id} style={{ margin: "1rem 0" }}>
            <strong>{new Date(m.createdAt).toLocaleString("ko-KR")}</strong>
            {" · "}
            {m.status === "sealed" ? "검산 완료" : "수집 중"}
            {" · "}선택 {m.expectedDocuments.toLocaleString()}건{" · "}기독{" "}
            {m.christianFiles.toLocaleString()}개 / 일반{" "}
            {m.generalFiles.toLocaleString()}개{" "}
            <button
              type="button"
              disabled={loading || m.status !== "sealed"}
              onClick={() => void inspect(m.id)}
            >
              참조 관계 미리보기
            </button>
          </li>
        ))}
      </ul>
      {loading && (
        <p role="status">등록 대상과 참조 관계를 검토하고 있습니다.</p>
      )}
      {error && (
        <p role="alert" style={{ color: "crimson" }}>
          {error}
        </p>
      )}
      {preview && selected && (
        <section
          aria-live="polite"
          style={{ borderTop: "1px solid #bbb", paddingTop: 20 }}
        >
          <h2>선택 목록 검토 결과</h2>
          <p>
            선택 문서 {preview.selectedDocuments.toLocaleString()}건 · 누락{" "}
            {preview.missing.toLocaleString()}건 · 버전 충돌{" "}
            {preview.versionConflicts.toLocaleString()}건
          </p>
          <p>
            수동 제외 {preview.manualExclusions.toLocaleString()}건 · 범위 제외{" "}
            {preview.scopeExclusions.toLocaleString()}건
          </p>
          <p>
            <strong>
              보관 후보 {preview.archiveBooks.toLocaleString()}권 /{" "}
              {preview.archiveDocuments.toLocaleString()}개 문서 (삭제하지 않음)
            </strong>
          </p>
          <h3>보관 후보의 관련 기록 건수</h3>
          <table>
            <thead>
              <tr>
                <th>관계 종류</th>
                <th>기록 건수</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(preview.relatedRecords).map(([kind, count]) => (
                <tr key={kind}>
                  <td>{kind}</td>
                  <td>{Number(count).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>{preview.warning}</p>
          <p>
            <strong>
              백업 검증: 미실시 · 기기 삭제 전파 검증: 미실시 · JSON 간접 참조
              검토: 미실시 · 삭제 승인: 없음
            </strong>
          </p>
        </section>
      )}
    </main>
  );
}
