import { test, expect } from "@playwright/test";
import { build } from "esbuild";
async function mount(page: any, source: string) {
  await page.route("https://library.test/", (r: any) =>
    r.fulfill({
      contentType: "text/html",
      body: '<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="max-width:560px;margin:auto;padding:16px"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.addStyleTag({ path: "src/app/globals.css" });
  const b = await build({
    stdin: { contents: source, resolveDir: process.cwd(), loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  await page.addScriptTag({ content: b.outputFiles[0].text });
}
for (const width of [390, 610, 1280])
  test(`summary is a lined single-line table at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("https://library.test/api/catalog-review**", (r: any) =>
      r.fulfill({
        json: r.request().url().includes("summary=1")
          ? {
              formats: ["paper", "logos", "ebook", "pdf"].map((format) => ({
                format,
                total: 4112,
                covers: 186,
                classified: 3784,
                verified: 85,
                reviewBooks: 3304,
                candidates: 13621,
                incomplete: 3990,
              })),
            }
          : { items: [], total: 0, nextOffset: null },
      }),
    );
    await mount(
      page,
      `import {createRoot} from 'react-dom/client';import {CatalogReviewPanel} from './src/components/catalog-review-panel';createRoot(document.getElementById('root')).render(<CatalogReviewPanel onChanged={async()=>{}}/>);`,
    );
    await expect(page.locator(".catalog-summary-table tbody tr")).toHaveCount(
      4,
    );
    expect(
      await page
        .locator(".catalog-summary-table th,.catalog-summary-table td")
        .evaluateAll((cells: any[]) =>
          cells.every(
            (c) =>
              getComputedStyle(c).whiteSpace === "nowrap" &&
              c.getBoundingClientRect().height < 40,
          ),
        ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const link = page.getByRole("link", { name: "로고스 표지 후보 확인" });
    expect((await link.boundingBox())!.height).toBeLessThan(40);
    await page.screenshot({
      path: test.info().outputPath(`summary-${width}.png`),
    });
  });
test("cover selection saves without an edition checkbox and failure allows retry", async ({
  page,
}) => {
  let posts: any[] = [];
  await page.route("https://library.test/api/logos/covers**", (r: any) => {
    if (r.request().method() === "POST") {
      posts.push(r.request().postDataJSON());
      return r.fulfill({
        status: posts.length === 1 ? 503 : 200,
        json: posts.length === 1 ? { error: "일시적 저장 오류" } : {},
      });
    }
    return r.fulfill({
      json: {
        items: [
          {
            id: "00000000-0000-4000-a000-000000000001",
            version: 7,
            title: "표지 검수 도서",
            author: "저자",
            candidates: [
              {
                isbn: "9780306406157",
                facts: {
                  title: "표지 검수 도서",
                  author: "저자",
                  publisher: "출판사",
                  coverUrl: "https://images.test/cover.png",
                },
              },
            ],
          },
        ],
        nextOffset: null,
      },
    });
  });
  await page.route("https://images.test/**", (r: any) =>
    r.fulfill({ status: 204 }),
  );
  await mount(
    page,
    `import {createRoot} from 'react-dom/client';import Page from './src/app/logos/covers/page';createRoot(document.getElementById('root')).render(<Page/>);`,
  );
  await expect(
    page.getByText("해당 책과 판본이 일치하는 표지임을 확인했습니다."),
  ).toHaveCount(0);
  const save = page.getByRole("button", { name: "표지 저장", exact: true });
  await expect(save).toBeDisabled();
  await page.getByRole("radio").check();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    page.getByRole("alert").filter({ hasText: "일시적 저장 오류" }),
  ).toBeVisible();
  await save.click();
  await expect(page.getByRole("status")).toContainText("저장했습니다");
  expect(posts).toHaveLength(2);
  expect(posts[0]).toMatchObject({
    expectedVersion: 7,
    coverUrl: "https://images.test/cover.png",
    verification: "manual",
  });
  await expect(
    page.getByRole("navigation").getByRole("link", { name: "나의 서재" }),
  ).toHaveClass(/compact-link/);
});
test("import navigation uses compact buttons and shorter labels", async ({
  page,
}) => {
  await page.route("https://library.test/api/**", (r: any) =>
    r.fulfill({ json: { registrationEnabled: false } }),
  );
  await mount(
    page,
    `import {createRoot} from 'react-dom/client';import Page from './src/app/logos/import/page';createRoot(document.getElementById('root')).render(<Page/>);`,
  );
  const nav = page.getByRole("navigation");
  await expect(
    nav.getByRole("link", { name: "나의 서재", exact: true }),
  ).toHaveClass(/compact-link/);
  await expect(
    nav.getByRole("link", { name: "로고스 표지 확인", exact: true }),
  ).toHaveAttribute("href", "/logos/covers");
});

test("Logos bulk saves independently and rejects an unsuitable candidate set", async ({
  page,
}) => {
  const books = [1, 2, 3].map((i) => ({
    id: `00000000-0000-4000-a000-00000000000${i}`,
    title: `후보 책 ${i}`,
    author: "저자",
    version: 1,
    candidates: [
      {
        isbn: "9780306406157",
        facts: {
          title: `후보 책 ${i}`,
          author: "저자",
          publisher: "출판사",
          coverUrl: `https://images.test/${i}.png`,
        },
      },
    ],
  }));
  let failed = false;
  const actions: any[] = [];
  let remaining = [...books];
  await page.route("https://images.test/**", (r: any) =>
    r.fulfill({ status: 204 }),
  );
  await page.route("https://library.test/api/logos/covers**", (r: any) => {
    if (r.request().method() === "POST") {
      const v = r.request().postDataJSON();
      actions.push(v);
      if (v.bookId === books[1].id && !failed) {
        failed = true;
        return r.fulfill({ status: 503, json: { error: "임시 실패" } });
      }
      remaining = remaining.filter((b) => b.id !== v.bookId);
      return r.fulfill({ json: {} });
    }
    return r.fulfill({ json: { items: remaining, nextOffset: null } });
  });
  await mount(
    page,
    `import {createRoot} from 'react-dom/client';import Page from './src/app/logos/covers/page';createRoot(document.getElementById('root')).render(<Page/>);`,
  );
  for (const i of [1, 2]) {
    await page
      .getByRole("checkbox", { name: `후보 책 ${i} 선택`, exact: true })
      .check();
    await page
      .locator(".logos-cover-card")
      .filter({
        has: page.getByRole("heading", { name: `후보 책 ${i}`, exact: true }),
      })
      .getByRole("radio")
      .check();
  }
  await page
    .getByRole("button", { name: "선택 표지 저장 (2권)", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("실패 1권");
  await expect(
    page.getByRole("checkbox", { name: "후보 책 2 선택", exact: true }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: "선택 표지 저장 (1권)", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "후보 책 2", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "거절", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "후보 책 3", exact: true }),
  ).toHaveCount(0);
  expect(actions.at(-1)).toMatchObject({
    action: "reject",
    bookId: books[2].id,
  });
  expect(actions.at(-1).coverUrl).toBeUndefined();
});
for (const width of [390, 1280])
  test(`inline PDF reviews show covers and support partial bulk success at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    let rows = [1, 2].map((i) => ({
      id: `00000000-0000-4000-a000-00000000000${i}`,
      book_id: `00000000-0000-4000-b000-00000000000${i}`,
      title: `PDF 책 ${i}`,
      alternatives: [
        {
          id: `00000000-0000-4000-a000-00000000000${i}`,
          version: 1,
          status: "pending",
          current: {
            title: `PDF 책 ${i}`,
            author: "",
            publisher: "",
            isbn: "",
            coverUrl: "",
          },
          record: {
            title: `PDF 책 ${i}`,
            isbn: "9780306406157",
            url: "https://www.yes24.com/product/goods/1",
            facts: {
              title: `PDF 책 ${i}`,
              author: "후보 저자",
              publisher: "출판사",
              isbn: "9780306406157",
              coverUrl: "https://images.test/cover.png",
            },
          },
        },
      ],
    }));
    let failed = false;
    const sent: any[] = [];
    let currentFormat = "";
    await page.route("https://images.test/**", (r: any) =>
      r.fulfill({ status: 204 }),
    );
    await page.route("https://library.test/api/catalog-review**", (r: any) => {
      const u = new URL(r.request().url());
      if (r.request().method() === "POST") {
        const v = r.request().postDataJSON();
        sent.push(v);
        if (v.id.endsWith("2") && !failed) {
          failed = true;
          return r.fulfill({ status: 409, json: { error: "후보 충돌" } });
        }
        rows = rows.filter((b) => b.id !== v.id);
        return r.fulfill({ json: {} });
      }
      if (u.searchParams.has("summary"))
        return r.fulfill({ json: { formats: [] } });
      currentFormat = u.searchParams.get("format") ?? "";
      return r.fulfill({
        json: { items: rows, total: rows.length, nextOffset: null },
      });
    });
    await page.route("https://library.test/api/logos/covers**", (r: any) =>
      r.fulfill({ json: { items: [], nextOffset: null } }),
    );
    await mount(
      page,
      `import {createRoot} from 'react-dom/client';import {CatalogReviewPanel} from './src/components/catalog-review-panel';createRoot(document.getElementById('root')).render(<CatalogReviewPanel onChanged={async()=>{}}/>);`,
    );
    await expect(page.locator(".inline-review-card")).toHaveCount(2);
    expect(currentFormat).toBe("pdf");
    await expect(
      page.getByRole("img", { name: "PDF 책 1 표지 후보" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`pdf-inline-${width}.png`),
    });
    await page
      .getByRole("checkbox", { name: "검토 목록 전체 선택", exact: true })
      .check();
    for (const i of [1, 2])
      await page
        .getByRole("checkbox", { name: `PDF 책 ${i} 판본 확인`, exact: true })
        .check();
    await page
      .getByRole("button", { name: "일괄 적용 (2권)", exact: true })
      .click();
    await expect(page.getByText("후보 충돌", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: "PDF 책 2 선택", exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: "PDF 책 2 ISBN 반영", exact: true }),
    ).toBeChecked();
    await page
      .getByRole("button", { name: "일괄 적용 (1권)", exact: true })
      .click();
    await expect(page.locator(".inline-review-card")).toHaveCount(0);
    expect(sent[1].requestId).toBe(sent[2].requestId);
    await page.getByRole("tab", { name: "로고스", exact: true }).click();
    await expect(
      page.getByText("이 상태의 후보가 없습니다.", {
        exact: false,
      }),
    ).toBeVisible();
    await page.getByRole("tab", { name: "PDF", exact: true }).click();
    await expect(
      page.getByText("이 상태의 후보가 없습니다.", { exact: true }),
    ).toBeVisible();
  });

test("format tabs share field comparisons, selected supplements and whole-row rejection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 950 });
  const sent: any[] = [];
  const formats: string[] = [];
  let removed = false;
  const candidate = {
    id: "00000000-0000-4000-a000-000000000001",
    candidateKey: "stored-candidate",
    version: 1,
    status: "pending",
    current: {
      title: "로고스 검토 도서",
      author: "기존 저자",
      publisher: "",
      isbn: "",
      coverUrl: "",
      description: "",
      toc: [],
    },
    record: {
      provider: "예스24",
      title: "로고스 검토 도서",
      isbn: "9780306406157",
      url: "https://www.yes24.com/product/goods/1",
      description: "후보 소개",
      toc: ["서론", "본론"],
      facts: {
        title: "로고스 검토 도서",
        author: "후보 저자",
        publisher: "후보 출판사",
        isbn: "9780306406157",
        coverUrl: "",
      },
    },
  };
  await page.route("https://library.test/api/catalog-review**", (r) => {
    const u = new URL(r.request().url());
    if (r.request().method() === "POST") {
      const v = r.request().postDataJSON();
      sent.push(v);
      removed = true;
      return r.fulfill({ json: {} });
    }
    if (u.searchParams.has("summary"))
      return r.fulfill({ json: { formats: [], residualReviewBooks: 1 } });
    const format = u.searchParams.get("format") ?? "";
    formats.push(format);
    const rows =
      format === "logos" && !removed
        ? [
            {
              id: candidate.id,
              book_id: candidate.id,
              title: candidate.current.title,
              alternatives: [
                candidate,
                { ...candidate, candidateKey: "second-candidate" },
              ],
            },
          ]
        : [];
    return r.fulfill({
      json: { items: rows, total: rows.length, nextOffset: null },
    });
  });
  await mount(
    page,
    `import {createRoot} from 'react-dom/client';import {CatalogReviewPanel} from './src/components/catalog-review-panel';createRoot(document.getElementById('root')).render(<CatalogReviewPanel onChanged={async()=>{}}/>);`,
  );
  await expect(page.getByRole("tab")).toHaveText([
    "PDF",
    "로고스",
    "전자책",
    "종이책",
    "기타도서",
  ]);
  await page.getByRole("tab", { name: "로고스", exact: true }).click();
  await expect(
    page
      .locator(".inline-review-field")
      .getByText("현재: 기존 저자", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: "검토 목록 전체 선택", exact: true })
    .check();
  for (const label of ["출판사", "ISBN", "목차"])
    await page
      .getByRole("checkbox", {
        name: `로고스 검토 도서 ${label} 반영`,
        exact: true,
      })
      .uncheck();
  await page
    .getByRole("checkbox", { name: "로고스 검토 도서 판본 확인", exact: true })
    .check();
  await page
    .getByRole("button", { name: "일괄 적용 (1권)", exact: true })
    .click();
  await expect(page.locator(".inline-review-card")).toHaveCount(0);
  expect(sent[0].fields).toEqual(["description"]);
  expect(sent[0].candidateKey).toBe("stored-candidate");
  removed = false;
  await page.getByRole("tab", { name: "전자책", exact: true }).click();
  await page.getByRole("tab", { name: "로고스", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "검토 목록 전체 선택", exact: true })
    .check();
  await page
    .getByRole("button", { name: "일괄 거절 (1권)", exact: true })
    .click();
  expect(sent.at(-1)).toMatchObject({ action: "reject", rejectAll: true });
  await expect(page.locator(".inline-review-card")).toHaveCount(0);
  for (const name of ["종이책", "기타도서"])
    await page.getByRole("tab", { name, exact: true }).click();
  expect(formats).toEqual(
    expect.arrayContaining(["pdf", "logos", "ebook", "paper", "other"]),
  );
});

test("individual cover save blocks bulk actions and paging until it finishes", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered = false;
  await page.route("https://library.test/api/logos/covers**", async (r) => {
    if (r.request().method() === "POST") {
      entered = true;
      await gate;
      return r.fulfill({ json: {} });
    }
    return r.fulfill({
      json: {
        items: [
          {
            id: "00000000-0000-4000-a000-000000000001",
            version: 1,
            title: "진행 중인 책",
            author: "저자",
            candidates: [
              {
                isbn: "9780306406157",
                facts: {
                  title: "진행 중인 책",
                  author: "저자",
                  publisher: "출판사",
                  coverUrl: "https://images.test/cover.png",
                },
              },
            ],
          },
        ],
        nextOffset: 50,
      },
    });
  });
  await page.route("https://images.test/**", (r) => r.fulfill({ status: 204 }));
  await mount(
    page,
    `import {createRoot} from 'react-dom/client';import Page from './src/app/logos/covers/page';createRoot(document.getElementById('root')).render(<Page/>);`,
  );
  await page.getByRole("radio").check();
  await page
    .getByRole("checkbox", { name: "진행 중인 책 선택", exact: true })
    .check();
  await page.getByRole("button", { name: "표지 저장", exact: true }).click();
  await expect.poll(() => entered).toBe(true);
  try {
    await expect(
      page.getByRole("button", { name: "선택 표지 저장 (1권)", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "다음 50권", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
});
