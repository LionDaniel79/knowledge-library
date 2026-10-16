import { describe, expect, it } from "vitest";
import {
  validDate,
  monthCells,
  readingStats,
  carouselIndex,
  bookInput,
  noteInput,
} from "../src/lib/domain";
describe("reading rules", () => {
  it("rejects impossible dates without timezone shifting", () => {
    expect(validDate("2026-02-30")).toBe(false);
    expect(validDate("2024-02-29")).toBe(true);
    expect(validDate("2026-2-09")).toBe(false);
    expect(validDate("2026-10-09")).toBe(true);
  });
  it("places October 2026 Thursday first and preserves date-only keys", () => {
    const cells = monthCells("2026-10");
    expect(cells).toHaveLength(42);
    expect(cells[0]).toBe("2026-09-27");
    expect(cells[4]).toBe("2026-10-01");
    expect(cells[13]).toBe("2026-10-10");
  });
  it("stops the carousel at either boundary including empty and single lists", () => {
    expect(carouselIndex(0, -1, 4)).toBe(0);
    expect(carouselIndex(3, 1, 4)).toBe(3);
    expect(carouselIndex(1, 1, 4)).toBe(2);
    expect(carouselIndex(0, 1, 1)).toBe(0);
    expect(carouselIndex(0, 1, 0)).toBe(0);
  });
  it("counts rereads separately, ignores unknown completion dates and keeps prior history", () => {
    const cycles = [
      { id: "1", bookId: "a", status: "completed", completedOn: "2026-09-30" },
      { id: "2", bookId: "a", status: "completed", completedOn: "2026-10-02" },
      { id: "3", bookId: "a", status: "completed", completedOn: "2026-10-09" },
      { id: "4", bookId: "b", status: "completed", completedOn: null },
      { id: "5", bookId: "a", status: "reading", completedOn: null },
    ];
    expect(readingStats(cycles, "2026-10")).toMatchObject({
      monthCount: 2,
      uniqueBooks: 1,
      yearCount: 3,
      rereads: 2,
      readingCount: 1,
      undatedCount: 1,
    });
    expect(
      readingStats([{ ...cycles[2], completedOn: "2026-11-01" }], "2026-10")
        .monthCount,
    ).toBe(0);
  });
  it("validates a book title and allows one edition with both paper and PDF holdings", () => {
    expect(
      bookInput.safeParse({ title: "  ", author: "", formats: ["paper"] })
        .success,
    ).toBe(false);
    expect(
      bookInput.parse({
        title: " 책 ",
        author: " 저자 ",
        formats: ["paper", "pdf"],
      }),
    ).toMatchObject({ title: "책", author: "저자", formats: ["paper", "pdf"] });
    expect(
      bookInput.safeParse({
        title: "책",
        author: "저자",
        formats: ["paper"],
        totalPages: -1,
      }).success,
    ).toBe(false);
  });
  it("requires a source for a highlight but accepts independent thoughts", () => {
    expect(
      noteInput.safeParse({
        title: "질문",
        content: "왜?",
        kind: "thought",
        bookId: null,
      }).success,
    ).toBe(true);
    expect(
      noteInput.safeParse({
        title: "문장",
        content: "발췌",
        kind: "highlight",
        bookId: null,
        page: 12,
      }).success,
    ).toBe(false);
  });
});
