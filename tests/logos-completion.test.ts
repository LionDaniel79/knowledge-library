import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideLogosCandidate,
  type LogosCandidate,
} from "../src/local/curation/logos-discovery";
import { runLogosCompletion } from "../src/local/curation/logos-runner";
import { logosLookup } from "../src/local/curation/logos-providers";
import { LibraryError } from "../src/server/library-store";
import { CatalogQuotaError } from "../src/local/curation/api-quota";

const book = {
  id: "abcd",
  version: 1,
  resourceId: "LLS:BOOK",
  title: "A History: Volume 1",
  author: "John Writer",
  publisher: "Publisher",
  isbn: "",
  publicationDate: "2020",
  edition: "Second edition",
  resourceType: "학술지",
};
const candidate: LogosCandidate = {
  provider: "예스24",
  url: "https://www.yes24.com/product/goods/123",
  isbn: "9788936434267",
  title: book.title,
  facts: {
    title: book.title,
    author: book.author,
    publisher: book.publisher,
    isbn: "9788936434267",
    coverUrl: "https://image.yes24.com/123",
  },
  publicationYear: "2020",
  edition: "Second edition",
  format: "digital",
};

it("requires digital edition evidence for ISBN-less Logos, retaining distinct volumes and conflicting publishers", () => {
  expect(decideLogosCandidate(book, [candidate]).state).toBe("certain");
  expect(
    decideLogosCandidate(book, [{ ...candidate, format: "print" }]).state,
  ).toBe("review");
  expect(
    decideLogosCandidate({ ...book, title: "Journal 1-2" }, [
      { ...candidate, facts: { ...candidate.facts, title: "Journal 12" } },
    ]).state,
  ).toBe("missing");
  expect(
    decideLogosCandidate(book, [{ ...candidate, edition: "" }]).state,
  ).toBe("review");
  expect(
    decideLogosCandidate(book, [
      {
        ...candidate,
        facts: { ...candidate.facts, title: "A History: Volume 2" },
      },
    ]).state,
  ).toBe("missing");
  expect(
    decideLogosCandidate(book, [
      { ...candidate, facts: { ...candidate.facts, publisher: "Other" } },
    ]).state,
  ).toBe("review");
  expect(
    decideLogosCandidate(book, [
      candidate,
      {
        ...candidate,
        isbn: "9780306406157",
        facts: { ...candidate.facts, isbn: "9780306406157" },
      },
    ]).state,
  ).toBe("review");
});

it("checkpoints bounded candidate lookups, resumes without provider calls, and applies only once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "logos-completion-"));
  let calls = 0,
    applied = 0;
  const options = {
    owner: "owner-a",
    dir,
    books: [
      book,
      { ...book, id: "other", resourceId: "LLS:OTHER", resourceType: "단행본" },
    ],
    online: true,
    apply: false,
    limit: 1,
    lookup: async () => {
      calls++;
      return [candidate];
    },
    applyDecision: async () => {
      applied++;
      return "complete" as const;
    },
  };
  try {
    expect((await runLogosCompletion(options)).pending).toBe(1);
    expect(calls).toBe(1);
    expect(
      (await runLogosCompletion({ ...options, online: false, apply: true }))
        .applied,
    ).toBe(1);
    expect(calls).toBe(1);
    await runLogosCompletion({ ...options, online: false, apply: true });
    expect(applied).toBe(1);
    const status = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
    expect(status.pending).toBe(1);
    // A separate owner must not reuse an applied checkpoint or cached candidates.
    expect(
      (
        await runLogosCompletion({
          ...options,
          owner: "owner-b",
          online: false,
        })
      ).pending,
    ).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("persists a sanitized stop and retries a failed provider instead of caching it as missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "logos-error-"));
  try {
    const options = {
      owner: "owner",
      dir,
      books: [book],
      online: true,
      apply: false,
      limit: 1,
      lookup: async () => {
        throw Error("credential=secret");
      },
      applyDecision: async () => "complete" as const,
    };
    expect((await runLogosCompletion(options)).stopped).toBe("error");
    expect(await readFile(join(dir, "status.json"), "utf8")).not.toContain(
      "secret",
    );
    expect(
      (
        await runLogosCompletion({
          ...options,
          lookup: async () => [candidate],
        })
      ).certain,
    ).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("advances past cached previews on the next bounded discovery run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "logos-next-"));
  let calls = 0;
  const options = {
    owner: "owner",
    dir,
    books: [book, { ...book, id: "next", resourceId: "LLS:NEXT" }],
    online: true,
    apply: false,
    limit: 1,
    lookup: async () => {
      calls++;
      return [candidate];
    },
    applyDecision: async () => "complete" as const,
  };
  try {
    await runLogosCompletion(options);
    await runLogosCompletion(options);
    expect(calls).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("records all pending resources when paused before the next request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "logos-pause-"));
  const controller = new AbortController();
  controller.abort();
  try {
    const stats = await runLogosCompletion({
      owner: "owner",
      dir,
      books: [book],
      online: true,
      apply: false,
      limit: 1,
      signal: controller.signal,
      lookup: async () => {
        throw Error("must not request");
      },
      applyDecision: async () => "complete",
    });
    expect(stats).toMatchObject({ stopped: "paused", pending: 1, requests: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("discovers title/author/publisher candidates with quota reservations and reuses individual provider caches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "logos-provider-"));
  const requests: URL[] = [],
    reservations: string[] = [];
  const lookup = logosLookup({
    dir,
    libraryKey: "library-test",
    yes24Key: "yes24-test",
    reserve: (p) => {
      reservations.push(p);
    },
    fetcher: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.hostname === "data4library.kr")
        return Response.json({ response: { numFound: 0, docs: [] } });
      return Response.json({
        success: true,
        data: {
          items: [
            {
              itemId: 123,
              isbn13: candidate.isbn,
              title: book.title,
              author: book.author,
              publisher: book.publisher,
              cover: "",
              goodsSortNm: "eBook",
              publicationDate: "2020",
              edition: "Second edition",
            },
          ],
        },
      });
    },
  });
  try {
    const records = await lookup(book);
    expect(records).toHaveLength(1);
    expect(
      requests
        .find((u) => u.hostname === "data4library.kr")
        ?.searchParams.get("publisher"),
    ).toBe(book.publisher);
    expect(
      requests
        .find((u) => u.hostname === "data4library.kr")
        ?.searchParams.get("author"),
    ).toBe(book.author);
    await lookup(book);
    expect(requests).toHaveLength(2);
    expect(reservations).toEqual(["library", "yes24"]);
    expect(decideLogosCandidate(book, records).state).toBe("certain");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("backs off a failed image durably so a bounded resume reaches later resources without re-fetching candidates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "logos-cover-retry-"));
  let now = 100000,
    calls = 0;
  const attempted: string[] = [];
  const next = { ...book, id: "next", resourceId: "LLS:NEXT" };
  const options = {
    owner: "owner",
    dir,
    books: [book, next],
    online: true,
    apply: true,
    limit: 1,
    now: () => now,
    lookup: async () => {
      calls++;
      return [candidate];
    },
    applyDecision: async (item: typeof book) => {
      attempted.push(item.id);
      return item.id === book.id
        ? ("cover_failed" as const)
        : ("complete" as const);
    },
  };
  try {
    const failed = await runLogosCompletion(options);
    expect(failed).toMatchObject({
      applied: 0,
      failed: 1,
      pending: 2,
      stopped: "complete",
    });
    expect(failed.retryAt).toBe(new Date(now + 60000).toISOString());
    const resumed = await runLogosCompletion(options);
    expect(resumed).toMatchObject({ applied: 1, deferred: 1, pending: 1 });
    expect(attempted).toEqual([book.id, next.id]);
    expect(calls).toBe(2);
    now += 60000;
    const retried = await runLogosCompletion(options);
    expect(retried).toMatchObject({ failed: 1, applied: 0, pending: 1 });
    expect(retried.retryAt).toBe(new Date(now + 120000).toISOString());
    expect(attempted).toEqual([book.id, next.id, book.id]);
    expect(calls).toBe(2);
    now += 120000;
    expect((await runLogosCompletion(options)).quarantined).toBe(1);
    now += 86400000;
    const quarantined = await runLogosCompletion(options);
    expect(quarantined).toMatchObject({
      quarantined: 1,
      pending: 1,
      applied: 0,
    });
    expect(attempted).toEqual([book.id, next.id, book.id, book.id]);
    expect(await readFile(join(dir, "status.json"), "utf8")).not.toContain(
      candidate.facts.coverUrl,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([
  new LibraryError(403, "private auth detail"),
  new CatalogQuotaError("2030-01-01T00:00:00.000Z"),
  Object.assign(Error("private schema detail"), { code: "42P01" }),
])(
  "stops on global apply errors instead of quarantining them as bad images",
  async (error) => {
    const dir = await mkdtemp(join(tmpdir(), "logos-global-stop-"));
    let attempted = 0;
    try {
      const stats = await runLogosCompletion({
        owner: "owner",
        dir,
        books: [book, { ...book, id: "next", resourceId: "LLS:NEXT" }],
        online: true,
        apply: true,
        limit: 2,
        lookup: async () => [candidate],
        applyDecision: async () => {
          attempted++;
          throw error;
        },
      });
      expect(stats.stopped).toBe(
        error instanceof CatalogQuotaError ? "quota" : "error",
      );
      expect(stats.pending).toBe(2);
      expect(attempted).toBe(1);
      expect(await readFile(join(dir, "status.json"), "utf8")).not.toContain(
        "private",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
