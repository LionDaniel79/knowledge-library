import type { Book } from "./domain";

// Broad KDC classes only; a generic commentary/dictionary/journal does not
// establish a subject. Never treat the Logos provider itself as religion proof.
const religion = new Set([
  "성경 주석",
  "설교",
  "성경",
  "성경 연구",
  "조직 신학",
  "성경 용어 색인",
  "성서 신학",
  "성구집",
  "성경 하모니",
  "교회사",
  "스터디 바이블",
  "신약입문서",
  "성경 아파라투스",
  "종교력",
  "교리문답서",
  "성서지도",
  "기도",
  "예배 안내서",
  "성경 노트",
  "신앙고백서",
  "구약입문서",
  "관주성경 색인",
  "신약개론",
  "찬송가",
]);
export function logosClassification(book: {
  resourceType: string;
  category?: string;
  classification?: Book["classification"];
}) {
  if (
    book.category ||
    book.classification?.method === "manual" ||
    book.classification?.verified
  )
    return null;
  const type = book.resourceType.normalize("NFKC").trim();
  const category = religion.has(type)
    ? "200"
    : type === "문법"
      ? "700"
      : ["전기", "자서전"].includes(type)
        ? "900"
        : type === "시"
          ? "800"
          : "";
  if (!category) return null;
  return {
    category,
    classification: {
      code: category,
      verified: false,
      method: "logos-resource-type/v1",
      source: `Logos XML 자료 유형: ${type} (임시 추정)`,
    },
  };
}
