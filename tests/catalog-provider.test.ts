import { it, expect } from "vitest";
import {
  parseLibraryResult,
  secureImage,
} from "../src/server/catalog-provider";
it("does not treat an inactive key response as an absent book or expose provider-echoed secrets", () => {
  let error: unknown;
  try {
    parseLibraryResult(
      {
        response: {
          error: "API 활성화 상태가아닙니다. authKey=example-secret",
        },
      },
      "9788983921987",
    );
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("인증키 승인 상태");
  expect(String(error)).not.toContain("example-secret");
  expect(
    parseLibraryResult({ response: { detail: [] } }, "9788983921987"),
  ).toBeNull();
});
it("only accepts the requested edition and retains the original KDC code", () => {
  const input = {
    response: {
      detail: [
        {
          book: {
            isbn13: "9780306406157",
            bookname: "책",
            class_no: "186.3",
            bookImageURL: "javascript:alert(1)",
          },
        },
      ],
    },
  };
  expect(parseLibraryResult(input, "9780306406157")).toMatchObject({
    category: "100",
    coverUrl: "",
    classification: { code: "186.3", verified: true },
  });
  expect(parseLibraryResult(input, "9788999727764")).toBeNull();
});

it("does not label missing library classification as verified", () => {
  const result = parseLibraryResult(
    {
      response: {
        detail: [
          { book: { isbn13: "9780306406157", bookname: "책", class_no: "" } },
        ],
      },
    },
    "9780306406157",
  );
  expect(result).toMatchObject({
    category: "",
    classification: { code: "", verified: false },
  });
});

it("uses the verified HTTPS Aladin image origin without upgrading arbitrary insecure URLs", () => {
  expect(secureImage("http://image.aladin.co.kr/book.jpg")).toBe(
    "https://image.aladin.co.kr/book.jpg",
  );
  for (const url of [
    "http://other.example/book.jpg",
    "http://image.aladin.co.kr.attacker.example/book.jpg",
    "http://image.aladin.co.kr:8080/book.jpg",
    "http://user:password@image.aladin.co.kr/book.jpg",
  ])
    expect(secureImage(url)).toBe("");
});
