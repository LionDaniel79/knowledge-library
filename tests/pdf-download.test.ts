import { expect, it } from "vitest";
import { pdfDownloadDisposition } from "../src/lib/pdf-download";
it("streams a Korean-named PDF as a device download with no local path or header injection", () => {
  const value = pdfDownloadDisposition("E:\\전자도서관\\나의 책\r\n.pdf");
  expect(value).toContain("attachment;");
  expect(value).toContain("filename*=UTF-8''");
  expect(value).not.toContain("E:");
  expect(value).not.toMatch(/[\r\n]/);
});
