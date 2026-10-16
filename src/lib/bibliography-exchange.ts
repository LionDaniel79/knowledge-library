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
