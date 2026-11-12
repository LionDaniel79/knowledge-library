import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readCachedPdfCandidates } from "../src/local/curation/pdf-cached-candidates";
it("suggests a title/author/publisher cache hit without assigning ISBN; validates stored ISBN evidence offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdf-cached-"));
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(Error("network forbidden"));
  try {
    await mkdir(join(root, "library"));
    await mkdir(join(root, "title-search"));
    const book = {
      title: "시험 도서",
      author: "시험 저자",
      publisher: "시험 출판사",
    };
    const evidence: any = {
      id: "document",
      ...book,
      signature: "signature",
      sha256: "hash",
      pageCount: 20,
      processingScope: "full",
      status: "ready",
      state: "scanned",
      candidates: [],
      pendingOcrPages: [],
      missingPages: [],
      unresolvedPages: [],
    };
    const isbn = "9780306406157";
    const facts = { ...book, isbn, coverUrl: "" };
    const key = createHash("sha256")
      .update(JSON.stringify({ title: book.title, author: book.author }))
      .digest("hex");
    await writeFile(
      join(root, "title-search", key + ".json"),
      JSON.stringify({
        query: book.title,
        author: book.author,
        result: { books: [facts, { ...facts, isbn: "9780306406158" }] },
      }),
    );
    const first = await readCachedPdfCandidates(root, book, evidence);
    expect(first.resolution).toMatchObject({ state: "review", isbn: "" });
    expect(first.titleResults[0].books).toHaveLength(1);
    const record = {
      provider: "도서관 정보나루",
      url: "https://data4library.kr",
      title: book.title,
      isbn,
      facts,
    };
    await writeFile(
      join(root, "library", isbn + ".json"),
      JSON.stringify({ record, retrievedAt: "2026-11-12" }),
    );
    evidence.candidates = [
      {
        isbn,
        evidence: [{ method: "text", labelled: true, secondaryContext: false }],
      },
    ];
    expect(
      (await readCachedPdfCandidates(root, book, evidence)).resolution,
    ).toMatchObject({ state: "verified", isbn });
    expect(
      (
        await readCachedPdfCandidates(
          root,
          { ...book, publisher: "다른 출판사" },
          evidence,
        )
      ).resolution.isbn,
    ).toBe("");
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    fetcher.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
