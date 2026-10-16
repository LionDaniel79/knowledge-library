import { describe, expect, it } from "vitest";
import {
  planZoteroSync,
  zoteroBookData,
  type SyncBook,
  type RemoteItem,
} from "../src/lib/zotero-sync";
const book: SyncBook = {
  id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  title: "책의 제목",
  author: "홍길동",
  publisher: "출판사",
  isbn: "9780140449136",
};
const remote: RemoteItem = {
  key: "ABCD2345",
  version: 4,
  data: {
    itemType: "book",
    title: "책의 제목",
    creators: [{ creatorType: "author", name: "홍길동" }],
    publisher: "출판사",
    ISBN: "9780140449136",
  },
};
function plan(books = [book], items: RemoteItem[] = [], links: any[] = []) {
  return planZoteroSync("owner", "123", 4, books, items, links);
}
describe("Zotero transfer decisions", () => {
  it("exports only bibliography and uses stable creation keys for interrupted retries", () => {
    const p = plan();
    expect(p.entries[0].action).toBe("create");
    expect(p.entries[0].key).toMatch(
      /^[23456789ABCDEFGHIJKLMNPQRSTUVWXYZ]{8}$/,
    );
    expect(plan().entries[0].key).toBe(p.entries[0].key);
    expect(
      zoteroBookData({
        ...book,
        content: "private",
        path: "E:/private.pdf",
        tags: ["personal"],
      } as SyncBook),
    ).toEqual(remote.data);
    expect(
      plan([book], [{ ...remote, key: p.entries[0].key }]).entries[0].action,
    ).toBe("link");
  });
  it("does not create duplicates or merge different editions on title or ISBN alone", () => {
    expect(plan([book], [remote]).entries[0].action).toBe("link");
    expect(
      plan(
        [book],
        [{ ...remote, data: { ...remote.data, title: "다른 권차" } }],
      ).entries[0].action,
    ).toBe("review");
    expect(
      plan([book], [remote, { ...remote, key: "BCDE2345" }]).entries[0].action,
    ).toBe("review");
    expect(
      plan([
        book,
        { ...book, id: "22222222-2222-4222-8222-222222222222" },
      ]).entries.map((x) => x.action),
    ).toEqual(["create", "review"]);
    expect(
      plan([{ ...book, isbn: "", author: "" }], [remote]).entries[0].action,
    ).toBe("review");
  });
  it("updates only previously synced unchanged remote versions; protects remote deletion and edits", () => {
    const link = {
      book_id: book.id,
      external_id: "users/123/ABCD2345",
      state: "active",
      version: 1,
      snapshot: { sync: { remoteVersion: 4, data: remote.data } },
    };
    expect(
      plan([{ ...book, title: "고친 제목", version: 2 }], [remote], [link])
        .entries[0].action,
    ).toBe("update");
    expect(
      plan(
        [{ ...book, title: "고친 제목" }],
        [{ ...remote, version: 5 }],
        [link],
      ).entries[0].action,
    ).toBe("review");
    expect(plan([book], [], [link]).entries[0].action).toBe("review");
    expect(
      plan([book], [remote], [{ ...link, state: "removed" }]).entries[0].action,
    ).toBe("review");
    expect(
      plan([{ ...book, title: "수정" }], [remote], [{ ...link, snapshot: {} }])
        .entries[0].action,
    ).toBe("review");
  });
  it("does not reuse a remote record already assigned to another holding", () => {
    expect(
      plan(
        [book],
        [remote],
        [
          {
            book_id: "other",
            external_id: "users/123/ABCD2345",
            state: "active",
            version: 1,
            snapshot: {},
          },
        ],
      ).entries[0].action,
    ).toBe("review");
    expect(plan([{ ...book, excluded: true }]).entries[0].action).toBe(
      "excluded",
    );
  });
  it("reviews the same title across mixed ISBN availability and different editions within one batch", () => {
    const other = { ...book, id: "22222222-2222-4222-8222-222222222222" };
    expect(
      plan([book, { ...other, isbn: "" }]).entries.map((e) => e.action),
    ).toEqual(["create", "review"]);
    expect(
      plan([{ ...book, isbn: "" }, other]).entries.map((e) => e.action),
    ).toEqual(["create", "review"]);
    expect(
      plan([book, { ...other, isbn: "9780306406157" }]).entries.map(
        (e) => e.action,
      ),
    ).toEqual(["create", "review"]);
  });
});
