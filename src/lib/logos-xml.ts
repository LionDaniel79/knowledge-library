import { logosRow, type LogosRow } from "./logos-contract";
const NS = "urn:schemas-microsoft-com:office:spreadsheet";
const value = (cell: Element) =>
  Array.from(cell.children)
    .find((x) => x.localName === "Data")
    ?.textContent?.trim() ?? "";
export function parseLogosXml(xml: string): LogosRow[] {
  if (new TextEncoder().encode(xml).length > 8 * 1024 * 1024)
    throw Error("로고스 XML은 8MB를 넘을 수 없습니다.");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml))
    throw Error("외부 엔티티나 DTD가 포함된 XML은 읽지 않습니다.");
  const parsed = new DOMParser().parseFromString(xml, "application/xml");
  if (parsed.getElementsByTagName("parsererror").length)
    throw Error("XML 형식을 확인할 수 없습니다.");
  const rows = Array.from(parsed.getElementsByTagNameNS(NS, "Row"));
  if (rows.length < 2 || rows.length > 5000)
    throw Error("로고스 도서 행 수를 확인해 주세요.");
  function rowCells(row: Element) {
    const out: string[] = [];
    let next = 0;
    for (const cell of Array.from(row.children).filter(
      (c) => c.localName === "Cell",
    )) {
      const index = cell.getAttributeNS(NS, "Index");
      if (index) {
        const n = Number(index);
        if (!Number.isSafeInteger(n) || n < 1 || n > 100)
          throw Error("XML 셀 인덱스를 확인해 주세요.");
        next = n - 1;
      }
      out[next++] = value(cell);
    }
    return out;
  }
  const headers = rowCells(rows[0]);
  const expected = ["Resource ID", "Title", "Authors", "Publishers", "License"];
  if (expected.some((h) => !headers.includes(h)))
    throw Error("Logos 서재 내보내기 형식이 아닙니다.");
  const results: LogosRow[] = [];
  const known = new Set<string>();
  for (const row of rows.slice(1)) {
    const cells = rowCells(row);
    const cell = (header: string) => cells[headers.indexOf(header)] ?? "";
    if (!cell("Resource ID")) continue;
    const licenseText = cell("License");
    const license =
      licenseText === "영구 소유"
        ? "permanent"
        : licenseText === "임시 소유"
          ? "temporary"
          : "unknown";
    const book = logosRow.parse({
      resourceId: cell("Resource ID"),
      title: cell("Title") || cell("Logos Title"),
      author: cell("Authors"),
      publisher: cell("Publishers"),
      license,
      series: cell("Series"),
      resourceType: cell("Resource Type"),
      language: cell("Languages"),
      publicationDate: cell("Publication Date"),
      edition: cell("Edition"),
    });
    if (known.has(book.resourceId))
      throw Error("중복 Resource ID: " + book.resourceId);
    known.add(book.resourceId);
    results.push(book);
  }
  if (!results.length) throw Error("로고스 도서 정보가 없습니다.");
  return results;
}
