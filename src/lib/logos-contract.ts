import { z } from "zod";
// Source: all 55 Resource Type values observed in the owner's 2026-11-03
// Logos Excel XML. Textual publications, including journals/magazines and
// course textbooks, are retained. Multimedia, interactive software, datasets,
// visualization-only resources and software dataset documentation are not books.
// Unknown future types fail closed for manual classification, not silent loss.
export const LOGOS_BOOK_RESOURCE_TYPES = [
  "고대 사본",
  "고대 사본 번역",
  "관주 색인",
  "관주성경 색인",
  "교리문답서",
  "교회사",
  "구약입문서",
  "기도",
  "단행본",
  "묵상",
  "문법",
  "백과사전",
  "사전",
  "서신",
  "설교",
  "성경",
  "성경 노트",
  "성경 아파라투스",
  "성경 연구",
  "성경 용어 색인",
  "성경 주석",
  "성경 하모니",
  "성구집",
  "성서 신학",
  "성서지도",
  "스터디 바이블",
  "시",
  "신앙고백서",
  "신약개론",
  "신약입문서",
  "아파라투스",
  "안내서",
  "어휘",
  "연구 길잡이",
  "예배 안내서",
  "예화",
  "용어 사전",
  "인용",
  "자서전",
  "잡지",
  "전기",
  "전집",
  "조직 신학",
  "종교력",
  "주석",
  "찬송가",
  "코스웨어 교과서",
  "학술지",
] as const;
export const LOGOS_EXCLUDED_TYPES = [
  "미디어 컬렉션",
  "코스웨어 미디어 컬렉션",
  "인터랙티브",
  "설명서",
  "구 시각화",
  "성경 인물 도표",
  "성경 장소 지도",
] as const;
export const logosRow = z
  .object({
    resourceId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9:._/-]+$/),
    title: z.string().trim().min(1).max(300),
    author: z.string().trim().max(300).default(""),
    publisher: z.string().trim().max(300).default(""),
    license: z.enum(["permanent", "temporary", "unknown"]),
    series: z.string().trim().max(300).default(""),
    resourceType: z.enum(LOGOS_BOOK_RESOURCE_TYPES),
    language: z.string().trim().max(80).default(""),
    publicationDate: z.string().trim().max(80).default(""),
    edition: z.string().trim().max(160).default(""),
  })
  .strict();
export const logosBatch = z
  .object({
    items: z.array(logosRow).min(1).max(100),
  })
  .strict()
  .refine(
    (x) => new Set(x.items.map((y) => y.resourceId)).size === x.items.length,
  );
export type LogosRow = z.infer<typeof logosRow>;
