import { expect, it } from "vitest";
import { pcPdfSearchUrl, pcPdfFolderUrl } from "../src/lib/pc-access";
import {
  authReturnPath,
  libraryEntry,
  readPdfSearchEntry,
} from "../src/lib/library-entry";

it("carries an exact search and document through same-window PC navigation and login", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const url = new URL(
    pcPdfSearchUrl("https://library.example.ts.net", "은혜 & 상담", id),
  );
  expect(url.origin).toBe("https://library.example.ts.net");
  const path = url.pathname + url.search;
  expect(authReturnPath(path)).toBe(path);
  expect(authReturnPath(path.replaceAll("+", "%20"))).toBe(path);
  expect(libraryEntry(Object.fromEntries(url.searchParams)).path).toBe(path);
  expect(readPdfSearchEntry(url.search)).toEqual({ q: "은혜 & 상담", id });
  expect(() => pcPdfSearchUrl("https://public.example", "query")).toThrow();
  expect(authReturnPath(path + "&next=https://public.example")).toBe("/");
  expect(authReturnPath(path + "&pdfQuery=overwritten")).toBe("/");
});
it("opens only folder settings and refuses malformed scopes", () => {
  const url = new URL(pcPdfFolderUrl("https://library.example.ts.net"));
  expect(url.searchParams.get("panel")).toBe("folder");
  expect(authReturnPath(url.pathname + url.search)).toBe(
    url.pathname + url.search,
  );
  expect(
    readPdfSearchEntry("?pdfMode=search&pdfQuery=test&pdfId=../secret"),
  ).toBeNull();
});
