import { createHash } from "node:crypto";
export type BibliographicBook = {
  id: string;
  title: string;
  author: string;
  publisher: string;
  isbn: string;
  materialKind?: string;
};
export type CslItem = {
  id: string;
  type: "book" | "article";
  title: string;
  author?: { literal: string }[];
  publisher?: string;
  ISBN?: string;
};
export function bibliography(books: BibliographicBook[]): CslItem[] {
  const unique = new Map<string, CslItem>();
  for (const b of books) {
    const value: Omit<CslItem, "id"> = {
      type: b.materialKind && b.materialKind !== "book" ? "article" : "book",
      title: b.title,
      ...(b.author ? { author: [{ literal: b.author }] } : {}),
      ...(b.publisher ? { publisher: b.publisher } : {}),
      ...(b.isbn ? { ISBN: b.isbn } : {}),
    };
    // A frozen citation stays identifiable even if the current book or research order changes.
    const hash = createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex");
    const id = `urn:knowledge-library:book:${b.id}:snapshot:${hash}`;
    unique.set(id, { id, ...value });
  }
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
}
const line = (value: string) =>
  value.replace(/[\r\n\u2028\u2029\x00-\x1F]+/g, " ").trim();
export function toRis(items: CslItem[]) {
  return (
    items
      .map((i) =>
        [
          `TY  - ${i.type === "book" ? "BOOK" : "GEN"}`,
          `ID  - ${line(i.id)}`,
          `TI  - ${line(i.title)}`,
          ...(i.author ?? []).map((a) => `AU  - ${line(a.literal)}`),
          ...(i.publisher ? [`PB  - ${line(i.publisher)}`] : []),
          ...(i.ISBN ? [`SN  - ${line(i.ISBN)}`] : []),
          "ER  -",
        ].join("\r\n"),
      )
      .join("\r\n\r\n") + "\r\n"
  );
}
export function zoteroLink(input: string) {
  const u = new URL(input);
  const match = u.pathname.match(
    /^\/(users|groups)\/([1-9][0-9]{0,19})\/items\/([A-Z0-9]{8})\/?$/,
  );
  if (
    u.protocol !== "https:" ||
    u.hostname !== "www.zotero.org" ||
    u.port ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !match
  )
    throw Error(
      "Zotero의 users 또는 groups 서재에 있는 항목 링크를 입력해 주세요. 인증키는 입력하지 마세요.",
    );
  return {
    url: `https://www.zotero.org/${match[1]}/${match[2]}/items/${match[3]}`,
    libraryType: match[1],
    libraryId: match[2],
    itemKey: match[3],
  };
}
