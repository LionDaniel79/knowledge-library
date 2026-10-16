export function isbn13(value: string): string {
  const v = value.replace(/[^0-9X]/gi, "").toUpperCase();
  if (
    v.length === 13 &&
    /^(978|979)\d{10}$/.test(v) &&
    [...v].reduce((s, n, i) => s + Number(n) * (i % 2 ? 3 : 1), 0) % 10 === 0
  )
    return v;
  if (
    /^\d{9}[\dX]$/.test(v) &&
    [...v].reduce((s, n, i) => s + (n === "X" ? 10 : Number(n)) * (10 - i), 0) %
      11 ===
      0
  ) {
    const base = "978" + v.slice(0, 9);
    return (
      base +
      ((10 -
        ([...base].reduce((s, n, i) => s + Number(n) * (i % 2 ? 3 : 1), 0) %
          10)) %
        10)
    );
  }
  return "";
}
export function extractIsbns(text: string): string[] {
  return [
    ...new Set(
      [
        ...text.matchAll(
          /(?:ISBN(?:-1[03])?\s*[:：]?\s*)?((?:97[89][\s-]*)?\d(?:[\s-]*\d){8}[\s-]*[\dX](?:[\s-]*\d){0,3})/gi,
        ),
      ]
        .map((m) => isbn13(m[1]))
        .filter(Boolean),
    ),
  ].slice(0, 12);
}
export const compactTitle = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.pdf$/i, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
export function sameTitle(a: string, b: string) {
  return compactTitle(a).length >= 3 && compactTitle(a) === compactTitle(b);
}
// These rules suggest broad KDC classes; they are never labeled library-verified.
const rules: [string, RegExp][] = [
  [
    "200",
    /신학|기독|성경|성서|교회|신앙|설교|목회|선교|종교|불교|theolog|christian|bible/i,
  ],
  ["100", /심리|철학|상담|정서|윤리|psycholog|philosoph/i],
  ["800", /소설|시집|문학|수필|novel|literature|poetry/i],
  ["900", /역사|전기|지리|history|biograph/i],
  ["300", /사회학|사회과학|정치|경제|경영|법학|교육학|sociolog|econom/i],
  ["400", /자연과학|물리학|생물학|수학|천문|진화론|physics|biology/i],
  ["500", /의학|간호|건강|요리|농업|공학|medicine|engineer/i],
  ["600", /예술|음악|미술|사진|영화|music|art history/i],
  ["700", /언어학|문법|영어|국어|중국어|linguistic|grammar/i],
  ["000", /컴퓨터|프로그래밍|문헌정보|백과사전|computer|programming/i],
];
export function suggestCategory(title: string, tags: string[]) {
  const text = tags.join(" ") + " " + title;
  return rules.find(([, re]) => re.test(text))?.[0] ?? "";
}
export function suggestNoteTags(content: string, bookTags: string[] = []) {
  const topics = [
    "상담",
    "감정",
    "정서",
    "관계",
    "신앙",
    "신학",
    "철학",
    "과학",
    "문학",
    "역사",
    "교육",
    "사랑",
    "죽음",
    "고통",
    "행복",
    "자아",
    "공동체",
  ];
  return [
    ...new Set([
      ...topics.filter((t) => content.includes(t)),
      ...bookTags.filter(
        (t) => topics.some((x) => t.includes(x)) && t.length <= 20,
      ),
    ]),
  ].slice(0, 8);
}

export function compatibleIsbn(existing: string, candidate: string) {
  return (
    !existing.trim() ||
    (!!isbn13(existing) && isbn13(existing) === isbn13(candidate))
  );
}
