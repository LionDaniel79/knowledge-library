import { Sha256Stream } from "./replica/codec";
import { displayProviderText } from "./provider-text";
export interface AutomaticInformation {
  fields: string[];
  pendingFields?: string[];
  status: string;
  afterValues: Record<string, unknown>;
  beforeValues?: Record<string, unknown>;
  provider?: string;
  url?: string;
}
export const informationFieldNames: Record<string, string> = {
  title: "제목",
  author: "저자",
  publisher: "출판사",
  isbn: "ISBN",
  coverUrl: "표지 주소",
  category: "분류",
  classification: "분류 근거",
  publicationYear: "출판 연도",
  description: "책 소개",
  toc: "목차",
  referenceIsbn: "참고 판본 ISBN",
  totalPages: "전체 쪽수",
  tag: "검색 태그",
  topic: "검색 주제",
  alias: "다른 표현",
  publisher_intro: "제공자 소개 발췌",
  review_digest: "리뷰를 참고한 소개",
  duplicate_candidate: "중복 확인 후보",
};
export function pendingAutomaticFields(
  a: AutomaticInformation | null | undefined,
): string[] {
  if (!a || a.status === "kept" || a.status === "undone") return [];
  return a.pendingFields ?? a.fields;
}
export interface CurrentBookInformation {
  fields: Record<string, unknown>;
  manualFields: string[];
  sources: Record<string, { provider: string; url?: string }>;
}
export function currentBookInformation(
  enrichment: any,
): CurrentBookInformation {
  const fields: Record<string, unknown> = {},
    sources: CurrentBookInformation["sources"] = {};
  const decisions: any[] = Object.values(
    enrichment?.catalogReviewDecisions ?? {},
  );
  for (const field of [
    "description",
    "toc",
    "publicationYear",
    "referenceIsbn",
  ]) {
    const value = enrichment?.["auto_" + field];
    if (
      value == null ||
      value === "" ||
      (Array.isArray(value) && !value.length)
    )
      continue;
    fields[field] = value;
    const decision = decisions
      .filter((d) => d.status === "applied" && d.fields?.includes(field))
      .at(-1);
    const selection = enrichment?.catalogReviewSelection;
    const source =
      (selection?.fields?.includes(field) ? selection : null) ??
      decision ??
      enrichment?.autoBibliography ??
      enrichment?.catalogSelection;
    sources[field] = {
      provider:
        source?.provider ??
        (enrichment?.autoBibliographyLocks?.includes(field)
          ? "사용자 선택"
          : "저장 자료"),
      url: source?.url ?? source?.sourceUrl,
    };
  }
  return {
    fields,
    manualFields: enrichment?.autoBibliographyLocks ?? [],
    sources,
  };
}
export interface InformationValue {
  value: unknown;
  itemIds: string[];
  automatic: boolean;
  manual: boolean;
  current?: boolean;
}
export interface InformationField {
  field: string;
  values: InformationValue[];
}
function normalizedInformationValue(field: string, value: unknown): string {
  if (typeof value === "string")
    return value
      .normalize("NFKC")
      .trim()
      .replace(
        field.toLowerCase().includes("isbn") ? /[\s-]+/g : /\s+/g,
        field.toLowerCase().includes("isbn") ? "" : " ",
      );
  if (Array.isArray(value))
    return JSON.stringify(
      value.map((v) => normalizedInformationValue(field, v)),
    );
  if (value && typeof value === "object")
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, normalizedInformationValue(k, v)]),
      ),
    );
  return JSON.stringify(value);
}
export function informationValueKey(field: string, value: unknown): string {
  const hash = new Sha256Stream();
  hash.update(
    new TextEncoder().encode(normalizedInformationValue(field, value)),
  );
  return hash.hex();
}
export function mergeBookInformation(
  items: any[],
  automatic?: AutomaticInformation | null,
  selections: Record<string, { itemId: string; valueKey: string }> = {},
  current?: CurrentBookInformation,
): InformationField[] {
  const result = new Map<string, InformationField>();
  function add(field: string, value: unknown, item: any | null) {
    if (
      value == null ||
      value === "" ||
      (Array.isArray(value) && !value.length)
    )
      return;
    if (field === "publisher_intro") field = "description";
    const row = result.get(field) ?? { field, values: [] };
    result.set(field, row);
    let variant = row.values.find(
      (v) =>
        informationValueKey(field, v.value) ===
        informationValueKey(field, value),
    );
    if (!variant) {
      variant = { value, itemIds: [], automatic: false, manual: false };
      row.values.push(variant);
    }
    if (item) {
      variant.itemIds.push(item.id);
      variant.manual ||=
        !!item.reviewed_by && item.reviewed_by !== "catalog_precheck";
    } else variant.automatic = true;
  }
  for (const item of items.filter((i) => i.state === "active")) {
    if (
      item.kind === "bibliography" &&
      item.value &&
      typeof item.value === "object" &&
      !Array.isArray(item.value)
    ) {
      for (const [field, value] of Object.entries(item.value))
        add(field, value, item);
    } else
      add(
        item.kind,
        typeof item.value === "string" ? displayProviderText(item) : item.value,
        item,
      );
  }
  if (automatic && automatic.status !== "undone")
    for (const field of automatic.fields)
      add(field, automatic.afterValues[field], null);
  if (current)
    for (const [field, value] of Object.entries(current.fields)) {
      add(field, value, null);
      const variant = result
        .get(field)
        ?.values.find(
          (v) =>
            informationValueKey(field, v.value) ===
            informationValueKey(field, value),
        );
      if (variant) {
        variant.current = true;
        variant.manual ||= current.manualFields.includes(field);
        variant.automatic =
          !!automatic?.fields.includes(field) &&
          informationValueKey(field, automatic.afterValues[field]) ===
            informationValueKey(field, value);
      }
    }
  for (const row of result.values()) {
    const selected = selections[row.field];
    const matches = (v: InformationValue) =>
      !!selected &&
      informationValueKey(row.field, v.value) === selected.valueKey &&
      (selected.itemId === "automatic"
        ? v.automatic
        : selected.itemId === "current"
          ? v.current
          : v.itemIds.includes(selected.itemId));
    row.values.sort(
      (a, b) =>
        Number(matches(b)) - Number(matches(a)) ||
        Number(b.manual) - Number(a.manual) ||
        Number(b.current ?? false) - Number(a.current ?? false) ||
        Number(b.automatic) - Number(a.automatic),
    );
  }
  return [...result.values()];
}
