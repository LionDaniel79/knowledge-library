import { curationItemSchema, type CurationItem } from "../../lib/curation";
import type { Database } from "../../server/library-store";
import { createCurationStore } from "../../server/curation-store";
import type { InventoryManifest } from "./inventory";
export function validateCurationItems(
  input: unknown,
  inventory: InventoryManifest,
) {
  const valid: CurationItem[] = [],
    rejected: { index: number; reason: string }[] = [];
  if (!Array.isArray(input)) throw Error("정비 항목 배열이 필요합니다.");
  const records = new Map(
      inventory.records.map((r) => [r.source.kind + ":" + r.source.id, r]),
    ),
    ids = new Set<string>();
  input.forEach((raw, index) => {
    const parsed = curationItemSchema.safeParse(raw);
    if (!parsed.success) {
      rejected.push({ index, reason: "항목 형식 오류" });
      return;
    }
    const i = parsed.data,
      s = records.get(i.source.kind + ":" + i.source.id),
      e = i.evidence;
    let reason = "";
    if (ids.has(i.id)) reason = "중복 항목 ID";
    else if (!s?.eligible) reason = "대상 범위 또는 원문 없음";
    else if (s.source.version !== i.source.version) reason = "원문 버전 변경";
    else if (e.referenceId) {
      const r = inventory.references.find(
        (r) =>
          r.id === e.referenceId &&
          r.source_kind === i.source.kind &&
          r.source_id === i.source.id &&
          r.source_version === i.source.version &&
          r.owner_id === inventory.owner,
      );
      if (
        !r ||
        r.edition_match === "unconfirmed" ||
        !r.excerpt.includes(e.quote)
      )
        reason = "확인되지 않은 서지 근거";
      else if (
        i.kind === "bibliography" &&
        (i.origin !== "provider" || r.edition_match !== "isbn")
      )
        reason = "공식 서지 확정 조건 불충족";
    } else if (
      !s.text.includes(e.quote) ||
      (e.start !== undefined && s.text.slice(e.start, e.end) !== e.quote) ||
      i.kind === "bibliography"
    )
      reason = "원문 근거 불일치";
    if (
      !reason &&
      i.source.kind === "book" &&
      !e.referenceId &&
      i.coverage !== "metadata"
    )
      reason = "서지 정보만으로 본문 전체를 주장할 수 없음";
    if (!reason && i.source.kind === "pdf_chunk" && i.coverage === "full")
      reason = "선택 페이지를 전체 책으로 주장할 수 없음";
    if (reason) rejected.push({ index, reason });
    else {
      ids.add(i.id);
      valid.push(i);
    }
  });
  return { valid, rejected };
}
export async function applyValidated(
  db: Database,
  owner: string,
  inventory: InventoryManifest,
  items: unknown,
  options: { apply?: boolean; runId?: string } = {},
) {
  if (owner !== inventory.owner)
    throw Error("자료 소유자가 일치하지 않습니다.");
  const validation = validateCurationItems(items, inventory);
  if (validation.valid.length > 100) throw Error("100건씩 반영해 주세요.");
  if (!options.apply)
    return {
      dryRun: true,
      valid: validation.valid.length,
      rejected: validation.rejected,
      applied: 0,
      runId: undefined,
    };
  if (validation.rejected.length) throw Error("검증에 실패한 항목이 있습니다.");
  const store = createCurationStore(db),
    runId =
      options.runId ??
      (await store.begin(
        owner,
        inventory.snapshotHash,
        "development-curation",
      ));
  const run = (
    await db.query(
      "SELECT scope_hash FROM library_curation_runs WHERE owner_id=$1 AND id=$2",
      [owner, runId],
    )
  ).rows[0];
  if (run?.scope_hash !== inventory.snapshotHash)
    throw Error("조사 자료와 정비 실행이 다릅니다.");
  return {
    dryRun: false,
    valid: validation.valid.length,
    rejected: validation.rejected,
    runId,
    ...(await store.apply(owner, runId, validation.valid)),
  };
}
