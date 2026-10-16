import type { Executor } from "./library-store";
import { LibraryError } from "./library-store";
import { valueText, type CurationExport } from "../lib/curation";
function redact(value: any): any {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) =>
            ![
              "owner_id",
              "token",
              "token_hash",
              "apiKey",
              "path",
              "root",
              "lease_token",
              "lease_device",
              "lease_expires_at",
            ].includes(k),
        )
        .map(([k, v]) => [k, redact(v)]),
    );
  return value;
}
export async function exportCuration(
  db: Executor,
  owner: string,
): Promise<CurationExport> {
  if (!owner) throw new LibraryError(401, "로그인이 필요합니다.");
  const names = {
    runs: "library_curation_runs",
    items: "library_curation_items",
    origins: "library_field_origins",
    sources: "library_reference_sources",
    assistRequests: "library_assist_requests",
    assistResults: "library_assist_results",
    aiUsage: "library_ai_usage",
  };
  const result: any = {};
  for (const [key, table] of Object.entries(names))
    result[key] = redact(
      (
        await db.query(
          `SELECT * FROM ${table} WHERE owner_id=$1 ORDER BY ${key === "sources" ? "retrieved_at" : "created_at"},id`,
          [owner],
        )
      ).rows,
    );
  return result;
}
export function curationMarkdown(data: CurationExport) {
  return (
    "# 검색용 정리 정보\n\n직접 작성한 메모와 구분되는 보조 자료입니다.\n\n" +
    data.items
      .map(
        (i) =>
          `## ${i.kind} · ${i.source_id}\n\n${valueText(i.value)}\n\n작성: ${i.origin} / 범위: ${i.coverage} / 상태: ${i.state}\n\n<details><summary>근거 보기</summary>\n\n${valueText(i.evidence)}\n\n</details>`,
      )
      .join("\n\n") +
    "\n\n<details><summary>근거 출처와 정비 실행 이력</summary>\n\n```json\n" +
    JSON.stringify({ sources: data.sources, runs: data.runs }, null, 2) +
    "\n```\n\n</details>\n" +
    "\n\n## 수정 이력\n\n```json\n" +
    JSON.stringify(data.origins, null, 2) +
    "\n```\n" +
    "\n\n# 명시적으로 요청한 AI 도움\n\n개인 원문과 별도로 보관한 요청·제안·채택 이력입니다.\n\n```json\n" +
    JSON.stringify(
      {
        requests: data.assistRequests ?? [],
        results: data.assistResults ?? [],
        usage: data.aiUsage ?? [],
      },
      null,
      2,
    ) +
    "\n```\n"
  );
}
