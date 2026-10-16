import { expect, it } from "vitest";
import { pageSize, pageWindow } from "../src/lib/list-pagination";

it("accepts only the four device page sizes and clamps empty or shortened lists", () => {
  for (const size of [10, 15, 30, 50])
    expect(pageSize(String(size))).toBe(size);
  for (const value of [null, "24", "1000000", "bad"])
    expect(pageSize(value)).toBe(30);
  expect(pageWindow(55, 10, 2)).toEqual({
    page: 2,
    pages: 6,
    offset: 20,
    start: 21,
    end: 30,
  });
  expect(pageWindow(9, 10, 2)).toEqual({
    page: 0,
    pages: 1,
    offset: 0,
    start: 1,
    end: 9,
  });
  expect(pageWindow(0, 15, 0)).toEqual({
    page: 0,
    pages: 1,
    offset: 0,
    start: 0,
    end: 0,
  });
});
