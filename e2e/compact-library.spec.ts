import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { previewLibrary } from "../src/lib/preview-data";
let bundle: string, barcode: Buffer;
test.beforeAll(async () => {
  bundle = (
    await build({
      entryPoints: ["e2e/harness.tsx"],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
  const L = [
      "0001101",
      "0011001",
      "0010011",
      "0111101",
      "0100011",
      "0110001",
      "0101111",
      "0111011",
      "0110111",
      "0001011",
    ],
    G = [
      "0100111",
      "0110011",
      "0011011",
      "0100001",
      "0011101",
      "0111001",
      "0000101",
      "0010001",
      "0001001",
      "0010111",
    ];
  const isbn = "9780306406157",
    parity = "LGGLGL";
  const bits =
    "101" +
    [...isbn.slice(1, 7)]
      .map((d, i) => (parity[i] === "L" ? L : G)[Number(d)])
      .join("") +
    "01010" +
    [...isbn.slice(7)]
      .map((d) => L[Number(d)].replace(/[01]/g, (c) => (c === "1" ? "0" : "1")))
      .join("") +
    "101";
  const bars = [...bits]
    .map((b, i) =>
      b === "1"
        ? `<rect x="${(i + 12) * 3}" y="10" width="3" height="160"/>`
        : "",
    )
    .join("");
  barcode = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="357" height="180"><rect width="100%" height="100%" fill="white"/><g fill="black">${bars}</g></svg>`,
    ),
  )
    .png()
    .toBuffer();
});
async function open(page: any, state: any) {
  await page.route("https://library.test/", (r: any) =>
    r.fulfill({
      contentType: "text/html",
      body: '<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.route("https://library.test/api/library", (r: any) =>
    r.fulfill({ json: state }),
  );
  await page.goto("https://library.test/");
  await page.addStyleTag({
    content: await readFile("src/app/globals.css", "utf8"),
  });
  await page.addScriptTag({ content: bundle });
}
async function nav(page: any, label: string) {
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page.getByRole("button", { name: new RegExp("^" + label) }).click();
}
for (const width of [390, 1440])
  test(`compact headings, counts, detail actions and editable cover at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/preview");
    await nav(page, "독서 통계");
    await expect(page.getByText(/기존앱 독서량/)).toHaveCount(0);
    expect(await page.locator(".main-content").innerText()).not.toMatch(
      /\d+회/,
    );
    await nav(page, "기록과 생각");
    await expect(page.locator(".heading-line h1")).toHaveText("기록과 생각");
    await expect(
      page.getByText("MY READING LIFE", { exact: true }),
    ).toHaveCount(0);
    const heading = await page.locator(".heading-line h1").boundingBox(),
      date = await page.locator(".heading-line time").boundingBox();
    expect(heading!.x).toBeGreaterThan(date!.x);
    expect(
      (await page.locator(".note-card").first().boundingBox())!.height,
    ).toBeLessThan(220);
    await nav(page, "소장 도서");
    await page.locator(".shelf-card").first().click();
    await expect(page.locator(".detail-actions button")).toHaveText([
      /읽기 시작/,
      "기록",
      "수정",
    ]);
    await expect(
      page.getByRole("button", { name: "책 정보 수정 이력" }),
    ).toHaveCount(0);
    await expect(page.locator(".book-evidence")).not.toContainText("표지");
    await page.getByRole("button", { name: "표지 수정", exact: true }).click();
    await page.getByLabel("파일 선택", { exact: true }).check();
    await expect(page.getByLabel("표지 파일 선택")).toBeVisible();
    await page.getByLabel("이미지 주소 입력", { exact: true }).check();
    await expect(page.getByLabel("표지 이미지 주소")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
test("tag deletion updates existing note tags and keeps their content", async ({
  page,
}) => {
  const state = structuredClone(previewLibrary),
    content = state.notes[0].content;
  state.notes[0].tags = ["삭제할태그"];
  let deleted = false;
  await page.route("https://library.test/api/note-tags", async (r) => {
    if (r.request().method() === "POST") {
      deleted = true;
      state.notes[0].tags = [];
      return r.fulfill({ json: { removed: 1 } });
    }
    return r.fulfill({
      json: deleted
        ? []
        : [
            {
              tag: "삭제할태그",
              count: 1,
              activeCount: 1,
              fingerprint: "a".repeat(64),
            },
          ],
    });
  });
  await open(page, state);
  await nav(page, "기록과 생각");
  await page.getByLabel("기록 태그 필터 · 태그 관리").click();
  await page
    .getByRole("button", { name: "태그 삭제 삭제할태그", exact: true })
    .click();
  await page.getByRole("button", { name: "태그 삭제", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "태그 삭제 삭제할태그", exact: true }),
  ).toHaveCount(0);
  expect(deleted).toBe(true);
  expect(state.notes[0].content).toBe(content);
});
test("barcode photo searches a checksum-valid ISBN, selection fills a new book, and uploaded covers save as private references", async ({
  page,
}) => {
  const state = structuredClone(previewLibrary);
  let searched = "",
    saved: any,
    uploaded = false;
  await page.route("https://library.test/api/book-lookup?*", (r) => {
    searched = new URL(r.request().url()).searchParams.get("q") ?? "";
    return r.fulfill({
      json: {
        items: [
          {
            id: "yes24:12",
            title: "검색한 책",
            author: "검색 저자",
            publisher: "출판사",
            isbn: "9780306406157",
            totalPages: 300,
            coverUrl: "",
            provider: "yes24",
            sourceUrl: "https://www.yes24.com/product/goods/12",
            description: "책 소개",
          },
        ],
        warnings: [],
      },
    });
  });
  await page.route("https://library.test/api/book-covers", (r) => {
    uploaded = true;
    expect(r.request().postDataBuffer()!.subarray(8, 12).toString()).toBe(
      "WEBP",
    );
    return r.fulfill({
      json: {
        id: "10000000-0000-4000-a000-000000000001",
        url: "/api/book-covers/10000000-0000-4000-a000-000000000001",
      },
    });
  });
  await open(page, state);
  await page.route("https://library.test/api/library", (r) => {
    if (r.request().method() === "POST") {
      saved = r.request().postDataJSON();
      return r.fulfill({ json: { id: "new", version: 1 } });
    }
    return r.fulfill({ json: state });
  });
  await page.getByRole("button", { name: "책 추가", exact: true }).click();
  await page.getByLabel("바코드 사진 선택").setInputFiles({
    name: "barcode.png",
    mimeType: "image/png",
    buffer: barcode,
  });
  await page.getByRole("button", { name: "선택", exact: true }).click();
  expect(searched).toBe("9780306406157");
  await expect(page.getByLabel("책 제목")).toHaveValue("검색한 책");
  await expect(page.getByLabel("저자", { exact: true })).toHaveValue(
    "검색 저자",
  );
  await page.getByLabel("파일 선택", { exact: true }).check();
  await page.getByLabel("표지 파일 선택").setInputFiles({
    name: "cover.png",
    mimeType: "image/png",
    buffer: barcode,
  });
  await expect(page.getByAltText("선택한 표지")).toBeVisible();
  await page.getByRole("button", { name: "저장하기", exact: true }).click();
  await expect
    .poll(() => saved?.payload?.coverUrl)
    .toContain("/api/book-covers/");
  expect(uploaded).toBe(true);
  expect(saved.payload.catalogSelection.provider).toBe("yes24");
});

test("tag deletion retries reuse the committed request after a lost response", async ({
  page,
}) => {
  const state = structuredClone(previewLibrary);
  state.notes[0].tags = ["재시도태그"];
  const requests: string[] = [];
  await page.route("https://library.test/api/note-tags", async (r) => {
    if (r.request().method() === "POST") {
      const id = r.request().postDataJSON().requestId;
      requests.push(id);
      state.notes[0].tags = [];
      if (requests.length === 1) return r.abort("connectionreset");
      return id === requests[0]
        ? r.fulfill({ json: { removed: 1 } })
        : r.fulfill({ status: 409, json: { error: "기록 변경 충돌" } });
    }
    return r.fulfill({
      json: requests.length
        ? []
        : [
            {
              tag: "재시도태그",
              count: 1,
              activeCount: 1,
              fingerprint: "b".repeat(64),
            },
          ],
    });
  });
  await open(page, state);
  await nav(page, "기록과 생각");
  await page.getByLabel("기록 태그 필터 · 태그 관리").click();
  await page
    .getByRole("button", { name: "태그 삭제 재시도태그", exact: true })
    .click();
  await page.getByRole("button", { name: "태그 삭제", exact: true }).click();
  await expect(page.locator(".tag-filter [role=alert]")).toBeVisible();
  await page.getByRole("button", { name: "태그 삭제", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toBe(requests[0]);
  await expect(page.getByRole("group", { name: "태그 삭제 확인" })).toHaveCount(
    0,
  );
});

test("cover controls cannot overwrite a pending upload", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("https://library.test/api/book-covers", async (r) => {
    await pending;
    await r.fulfill({
      json: { url: "/api/book-covers/10000000-0000-4000-a000-000000000001" },
    });
  });
  await open(page, structuredClone(previewLibrary));
  await page.getByRole("button", { name: "책 추가", exact: true }).click();
  await page.getByLabel("표지 이미지 주소").fill("https://example.com/old.jpg");
  await page.getByLabel("파일 선택", { exact: true }).check();
  await page.getByLabel("표지 파일 선택").setInputFiles({
    name: "cover.png",
    mimeType: "image/png",
    buffer: barcode,
  });
  await expect(
    page.getByText("표지를 저장하고 있습니다…", { exact: true }),
  ).toBeVisible();
  try {
    await expect(
      page.getByLabel("이미지 주소 입력", { exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "표지 제거", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(
    page.getByLabel("이미지 주소 입력", { exact: true }),
  ).toBeEnabled();
});

test("a backup with full cover quota and existing history can be inspected", async ({
  page,
}) => {
  await open(page, structuredClone(previewLibrary));
  await page.route("https://library.test/api/backup", (r) =>
    r.fulfill({
      json: {
        canRestore: false,
        existingRecords: 1,
        createdAt: "2026-10-16T00:00:00Z",
        counts: {},
      },
    }),
  );
  await page.getByRole("button", { name: "백업과 복원", exact: true }).click();
  // Exercise file admission without allocating a 330 MiB browser fixture.
  await page
    .getByLabel("복원할 백업 파일")
    .evaluate((input: HTMLInputElement) => {
      const file = new File(["{}"], "library-backup.json", {
        type: "application/json",
      });
      Object.defineProperty(file, "size", { value: 330 * 1024 * 1024 });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  await page.getByRole("button", { name: "백업 검사", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "백업 검사 결과" }),
  ).toBeVisible();
});
