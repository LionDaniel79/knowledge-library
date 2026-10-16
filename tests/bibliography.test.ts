import { it, expect } from "vitest";
import {
  isbn13,
  compatibleIsbn,
  extractIsbns,
  sameTitle,
  suggestCategory,
} from "../src/lib/bibliography";
it("rejects invalid ISBNs and requires exact normalized titles", () => {
  expect(isbn13("978-0-306-40615-7")).toBe("9780306406157");
  expect(isbn13("0-306-40615-2")).toBe("9780306406157");
  expect(isbn13("9780306406158")).toBe("");
  expect(extractIsbns("ISBN 978-0-306-40615-7")).toContain("9780306406157");
  expect(sameTitle("정서와 작업하기", "정서와 작업하기 2")).toBe(false);
  expect(sameTitle("정서와 작업하기", "정서와작업하기")).toBe(true);
  expect(suggestCategory("문학", [])).toBe("800");
});

it("does not borrow metadata from another edition when an ISBN already exists", () => {
  expect(compatibleIsbn("9780306406157", "9788999727764")).toBe(false);
  expect(compatibleIsbn("0-306-40615-2", "9780306406157")).toBe(true);
  expect(compatibleIsbn("invalid", "9780306406157")).toBe(false);
});
