import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
let bundle: string;
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
});
async function mount(page: Page) {
  await page.route("https://library.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="ko"><body><div id="root"></div></body></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
}
test("deletes only after confirmation and restores from the notes trash", async ({
  page,
}) => {
  const state = structuredClone(previewLibrary);
  const original = state.notes[0];
  let deletes = 0,
    restores = 0;
  await page.route("https://library.test/api/library", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: state });
    const command = route.request().postDataJSON();
    if (command.type === "deleteNote") {
      deletes++;
      expect(command.payload).toEqual({
        id: original.id,
        expectedVersion: original.version,
      });
      state.notes = state.notes.filter((n) => n.id !== original.id);
      state.deletedNotes = [
        {
          ...original,
          version: original.version + 1,
          deletedAt: "2026-10-15T00:00:00Z",
        },
      ];
    } else if (command.type === "restoreNote") {
      restores++;
      expect(command.payload.expectedVersion).toBe(original.version + 1);
      state.notes.unshift({ ...original, version: original.version + 2 });
      state.deletedNotes = [];
    } else throw Error("Unexpected write: " + command.type);
    return route.fulfill({
      json: { id: original.id, version: original.version + deletes + restores },
    });
  });
  await mount(page);
  await page.getByRole("button", { name: original.title, exact: true }).click();
  await page.getByRole("button", { name: "삭제", exact: true }).click();
  expect(deletes).toBe(0);
  await page
    .getByRole("button", { name: "휴지통으로 이동", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(deletes).toBe(1);
  await page.getByRole("button", { name: "메뉴 열기", exact: true }).click();
  await page.getByRole("button", { name: "기록과 생각", exact: true }).click();
  await page.getByText("휴지통 · 1개", { exact: true }).click();
  await page.getByRole("button", { name: "복원", exact: true }).click();
  await expect(page.getByText("휴지통 · 0개", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: original.title, exact: true }),
  ).toBeVisible();
  expect(restores).toBe(1);
});
test("keeps an unsaved draft through a version conflict and explicit reconciliation", async ({
  page,
}) => {
  let posts = 0;
  const latest = structuredClone(previewLibrary);
  latest.notes[0].version = 2;
  latest.notes[0].content = "다른 기기에서 남긴 생각";
  await page.route("https://library.test/api/library", async (r) => {
    if (r.request().method() === "GET") return r.fulfill({ json: latest });
    posts++;
    if (posts === 1)
      return r.fulfill({
        status: 409,
        json: { error: "다른 곳에서 수정된 기록입니다." },
      });
    expect(r.request().postDataJSON().payload).toMatchObject({
      expectedVersion: 2,
      content: "보존해야 할 내 초안",
    });
    return r.fulfill({ json: { id: latest.notes[0].id, version: 3 } });
  });
  await mount(page);
  await page
    .getByRole("button", {
      name: "이해한다는 것은 곁에 머무는 일",
      exact: true,
    })
    .click();
  await page
    .getByRole("textbox", { name: "내용", exact: true })
    .fill("보존해야 할 내 초안");
  await page.getByRole("button", { name: "저장하기", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "내용", exact: true }),
  ).toHaveValue("보존해야 할 내 초안");
  await expect(page.getByTestId("conflict-latest")).toContainText(
    "다른 기기에서 남긴 생각",
  );
  await page
    .getByRole("button", {
      name: "최신 내용을 확인했습니다. 내 초안을 유지합니다.",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "저장하기", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(posts).toBe(2);
});
test("freezes inputs until an in-flight save settles", async ({ page }) => {
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("https://library.test/api/library", async (r) => {
    if (r.request().method() === "POST") {
      await wait;
      return r.fulfill({ json: { id: "ok", version: 1 } });
    }
    return r.fulfill({ json: previewLibrary });
  });
  await mount(page);
  await page.getByRole("button", { name: "책 추가", exact: true }).click();
  await page.getByLabel("책 제목").fill("기록 보존");
  await page.getByRole("button", { name: "저장하기", exact: true }).click();
  try {
    await expect(page.getByLabel("책 제목")).toBeDisabled();
    await expect(page.getByLabel("저자", { exact: true })).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "닫기", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeVisible();
  } finally {
    release();
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("mobile account includes an accessible logout control", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page);
  await expect(
    page
      .getByRole("button", { name: "로그아웃", exact: true })
      .filter({ visible: true }),
  ).toBeVisible();
});
test("editing a completion date moves the book and counts to the chosen month", async ({
  page,
}) => {
  const state = structuredClone(previewLibrary);
  await page.route("https://library.test/api/library", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: state });
    const body = route.request().postDataJSON();
    expect(body.type).toBe("editCompletion");
    const cycle = state.cycles.find((c) => c.id === body.payload.id)!;
    expect(body.payload.expectedVersion).toBe(cycle.version);
    cycle.completedOn = body.payload.completedOn;
    cycle.version++;
    return route.fulfill({ json: { id: cycle.id, version: cycle.version } });
  });
  await mount(page);
  await page.getByRole("button", { name: "2026-10-09", exact: true }).click();
  await page.getByRole("button", { name: "날짜 수정", exact: true }).click();
  await page.getByLabel("완독한 날", { exact: true }).fill("2026-09-30");
  await page.getByRole("button", { name: "저장하기", exact: true }).click();
  await expect(page.getByTestId("month-total")).toContainText("2");
  await page.getByRole("button", { name: "이전 달", exact: true }).click();
  await expect(page.getByTestId("month-total")).toContainText("2");
  await page.getByRole("button", { name: "2026-09-30", exact: true }).click();
  await expect(page.getByTestId("selected-date-books")).toContainText(
    "읽는 삶",
  );
});

test("preserves shelf selection after a conflicting save and explicit comparison", async ({
  page,
}) => {
  const latest = structuredClone(previewLibrary);
  const book = latest.books[0];
  book.version = 2;
  book.bookshelves = ["내 인생 최고의 책들"];
  let posts = 0;
  await page.route("https://library.test/api/library", (r) => {
    if (r.request().method() === "GET") return r.fulfill({ json: latest });
    posts++;
    if (posts === 1)
      return r.fulfill({
        status: 409,
        json: { error: "책 정보가 변경되었습니다." },
      });
    const payload = r.request().postDataJSON().payload;
    expect(payload.expectedVersion).toBe(2);
    expect(payload.bookshelves).toEqual(["책 대기열"]);
    Object.assign(book, payload, { version: 3 });
    return r.fulfill({ json: { id: book.id, version: 3 } });
  });
  await mount(page);
  await page
    .getByRole("button", { name: "질문으로 살아가는 시간", exact: true })
    .click();
  await page.getByLabel("책 대기열", { exact: true }).check();
  await page.getByRole("button", { name: "책장 선택 저장" }).click();
  await expect(page.getByLabel("책 대기열", { exact: true })).toBeChecked();
  await expect(page.getByRole("alert")).toContainText("변경되었습니다");
  await expect(
    page.getByRole("button", { name: "책장 선택 저장" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "최신 책장을 확인했습니다. 내 선택 유지" })
    .click();
  await page.getByRole("button", { name: "책장 선택 저장" }).click();
  await expect(
    page.getByRole("button", { name: "책장 선택 저장" }),
  ).toHaveCount(0);
  expect(posts).toBe(2);
});
