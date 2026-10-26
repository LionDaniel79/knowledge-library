import { expect, it } from "vitest";
import {
  presentConflict,
  describeQueuedConflict,
} from "../src/lib/replica/conflict-presentation";
const entry = (type: string, row: any, path = "/api/library") =>
  ({
    family: "library",
    entityId: row.id ?? "test",
    command: {
      path,
      body: { type, payload: {} },
      effects: [{ entity: "library_notes", after: row }],
    },
  }) as any;
const review = (
  type: string,
  server: any,
  pc: any,
  entity = "library_notes",
  extra: any = {},
) => ({
  entry: entry(type, pc),
  base: server,
  latest: server,
  local: pc,
  primary: { entity },
  context: {
    bookTitles: { b: "넥서스" },
    topicNames: { t: "신뢰" },
    sourceTitles: {},
  },
  ...extra,
});
it("shows real reading pages and only marks differing fields, without import JSON", () => {
  const r = review(
    "updateProgress",
    {
      id: "r",
      book_id: "b",
      current_page: 465,
      status: "reading",
      source_data: { secret: "private-original" },
    },
    { id: "r", book_id: "b", current_page: 305, status: "reading" },
    "library_cycles",
  );
  const v = presentConflict(r);
  expect(v.title).toBe("넥서스");
  expect(v.operation).toBe("읽은 쪽 기록");
  expect(v.server.fields.find((f) => f.label === "읽은 쪽수")).toMatchObject({
    value: "465쪽",
    different: true,
  });
  expect(v.pc.fields.find((f) => f.label === "읽은 쪽수")).toMatchObject({
    value: "305쪽",
    different: true,
  });
  expect(v.server.fields.find((f) => f.label === "독서 상태")?.different).toBe(
    false,
  );
  expect(JSON.stringify(v)).not.toContain("private-original");
  expect(JSON.stringify(v)).not.toContain("source_data");
});
it("compares complete memo text, title, tags and linked books without flattening them to JSON", () => {
  const v = presentConflict(
    review(
      "editNote",
      {
        id: "n",
        title: "서버 제목",
        content: "서버의 글",
        tags: ["신뢰"],
        book_id: "b",
        kind: "thought",
      },
      {
        id: "n",
        title: "PC 제목",
        content: "PC의 글",
        tags: ["정서"],
        book_id: null,
        kind: "thought",
      },
    ),
  );
  expect(v.server.body).toBe("서버의 글");
  expect(v.pc.body).toBe("PC의 글");
  expect(v.pc.fields.find((f) => f.label === "제목")).toMatchObject({
    value: "PC 제목",
    different: true,
  });
  expect(v.server.fields.find((f) => f.label === "연결된 책")?.value).toBe(
    "넥서스",
  );
  expect(v.pc.fields.find((f) => f.label === "태그")?.value).toBe("정서");
});
it("makes a delete request visibly different even when memo text is unchanged", () => {
  const n = { id: "n", title: "독서 메모", content: "부커스 대여" };
  const v = presentConflict(review("deleteNote", n, n));
  expect(v.operation).toBe("메모 삭제");
  expect(v.server.intent).toBe("현재 기록 유지");
  expect(v.pc.intent).toBe("휴지통으로 이동");
  expect(v.pc.intent).not.toBe(v.server.intent);
  const trashed = presentConflict(
    review("deleteNote", n, n, "library_notes", {
      unavailable: "다른 기기에서 휴지통으로 이동했습니다.",
    }),
  );
  expect(trashed.server.intent).toBe("휴지통에 보관");
});
it("shows a bounded whiteboard layout without dumping position IDs", () => {
  const data = {
    positions: Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [
        `note::private-id-${i}`,
        { x: i * 12, y: i * 7 },
      ]),
    ),
    groups: [{}],
    links: [{}],
  };
  const v = presentConflict(
    review(
      "saveWhiteboard",
      { id: "board", data },
      { id: "board", data: { ...data, groups: [] } },
      "library_whiteboards",
    ),
  );
  expect(v.pc.board?.points.length).toBeLessThanOrEqual(160);
  expect(v.server.fields.find((f) => f.label === "직접 만든 묶음")?.value).toBe(
    "1개",
  );
  expect(v.pc.fields.find((f) => f.label === "직접 만든 묶음")).toMatchObject({
    value: "0개",
    different: true,
  });
  expect(JSON.stringify(v)).not.toContain("private-id");
});
it("names queued operations and the affected record instead of showing only an error", () => {
  expect(
    describeQueuedConflict(
      entry("deleteNote", {
        id: "n",
        title: "독서 메모",
        content: "부커스 대여",
      }),
    ),
  ).toMatchObject({
    operation: "메모 삭제",
    title: "독서 메모",
    detail: "부커스 대여",
  });
  expect(
    describeQueuedConflict(
      entry("updateProgress", { id: "r", current_page: 0 }),
    ).detail,
  ).toBe("0쪽");
});
it("marks changed whiteboard positions and different cover images even when counts are identical", () => {
  const a = {
      id: "w",
      data: { positions: { a: { x: 1, y: 1 } }, groups: [], links: [] },
    },
    b = { id: "w", data: { ...a.data, positions: { a: { x: 500, y: 600 } } } };
  expect(
    presentConflict(review("saveWhiteboard", a, b, "library_whiteboards"))
      .changed,
  ).toContain("메모 배치");
  const c = presentConflict(
    review(
      "editBook",
      { id: "b", title: "책", cover_url: "https://example.test/old.jpg" },
      { id: "b", title: "책", cover_url: "https://example.test/new.jpg" },
      "library_books",
    ),
  );
  expect(c.changed).toContain("표지");
  expect(c.server.image).not.toBe(c.pc.image);
});
it("uses catalogue status and edition facts in place of provider payloads", () => {
  const r = review(
    "",
    {
      id: "c",
      status: "pending",
      record: {
        title: "책의 판본",
        isbn: "9780306406157",
        facts: { author: "저자" },
      },
    },
    {
      id: "c",
      status: "rejected",
      record: { title: "책의 판본", isbn: "9780306406157" },
    },
    "library_catalog_reviews",
  );
  r.entry.command.path = "/api/catalog-review";
  const v = presentConflict(r);
  expect(v.operation).toBe("도서정보 후보 검토");
  expect(v.pc.fields.find((f) => f.label === "검토 상태")).toMatchObject({
    value: "거절",
    different: true,
  });
  expect(v.server.fields.find((f) => f.label === "ISBN")?.value).toBe(
    "9780306406157",
  );
});

it("exposes all editable book facts instead of treating different formats, pages or shelf as identical", () => {
  const v = presentConflict(
    review(
      "editBook",
      {
        id: "b",
        title: "책",
        formats: ["paper"],
        total_pages: 300,
        shelf: "서가 A",
      },
      {
        id: "b",
        title: "책",
        formats: ["pdf"],
        total_pages: 600,
        shelf: "외장하드",
      },
      "library_books",
    ),
  );
  expect(v.changed).toEqual(
    expect.arrayContaining(["소장 형태", "전체 쪽수", "보관 위치"]),
  );
  expect(v.server.fields.find((f) => f.key === "formats")?.value).toBe(
    "종이책",
  );
  expect(v.pc.fields.find((f) => f.key === "total_pages")?.value).toBe("600쪽");
});

it("explains whiteboard filters, groups, membership, layout and links even when their counts match", () => {
  const first = {
    id: "w",
    data: {
      positions: {},
      filter: {
        topics: ["t"],
        books: ["b"],
        tags: ["정서"],
        categories: ["100"],
        q: "",
      },
      groupPositions: { g: { x: 0, y: 0 } },
      groups: [{ id: "g", title: "예전 묶음", noteIds: ["n1"] }],
      links: [{ source: "g", target: "unclassified" }],
      collapsed: [],
    },
  };
  const second = {
    id: "w",
    data: {
      ...first.data,
      filter: { topics: [], books: [], tags: ["신뢰"], categories: [], q: "" },
      groupPositions: { g: { x: 10, y: 20 } },
      groups: [{ id: "g", title: "새 묶음", noteIds: ["n2"] }],
      links: [{ source: "g", target: "topic:t" }],
      collapsed: ["g"],
    },
  };
  const r = review("saveWhiteboard", first, second, "library_whiteboards");
  r.context.sourceTitles = { "note:n1": "첫 메모", "note:n2": "다음 메모" };
  const v = presentConflict(r);
  expect(v.changed).toEqual(
    expect.arrayContaining([
      "주제 필터",
      "태그 필터",
      "분야 필터",
      "도서 필터",
      "묶음 구성",
      "묶음 연결",
      "접힌 묶음",
      "묶음 배치",
    ]),
  );
  expect(
    v.server.fields.find((f) => f.key === "group_details")?.value,
  ).toContain("첫 메모");
  expect(v.pc.fields.find((f) => f.key === "link_details")?.value).toContain(
    "신뢰",
  );
});

it("compares book identities before translating same-title editions", () => {
  const r = review(
    "editNote",
    { id: "n", book_id: "b", title: "메모", content: "글" },
    { id: "n", book_id: "c", title: "메모", content: "글" },
  );
  r.context.bookTitles.c = "넥서스";
  (r.context as any).bookDetails = {
    b: "저자 · 첫 출판사 · 111",
    c: "저자 · 다른 출판사 · 222",
  };
  const v = presentConflict(r);
  expect(v.changed).toContain("연결된 책");
  expect(v.server.fields.find((f) => f.key === "book_id")).toMatchObject({
    different: true,
    value: "넥서스 · 저자 · 첫 출판사 · 111",
  });
  expect(v.pc.fields.find((f) => f.key === "book_id")?.value).toContain("222");
});
