import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `import{createRoot}from'react-dom/client';import{LibraryForm}from'./src/components/library-forms';const root=createRoot(document.getElementById('root'));window.rerender=()=>root.render(<LibraryForm editor={window.editor} library={window.fixture} today="2026-10-27" preview={false} onClose={()=>{}} onSave={async(c)=>{window.saved=c}}/>);window.rerender();`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
});
async function mount(page: Page, editing = false) {
  const note = {
    ...previewLibrary.notes[0],
    id: crypto.randomUUID(),
    title: "검수 기록",
    content: "입력 내용은 그대로 보존한다",
    kind: "thought",
    tags: ["독서 메모"],
  };
  const fixture = {
    ...previewLibrary,
    notes: [note, { ...note, id: crypto.randomUUID(), tags: ["신앙", "관계"] }],
    catalog: undefined,
  };
  const topics = [
    {
      id: crypto.randomUUID(),
      name: "기존 주제",
      parentId: null,
      aliases: [],
      description: "",
      kdcCodes: [],
      confirmed: true,
      version: 1,
    },
  ];
  const commands: any[] = [];
  let failCreate = false;
  let creationGate: Promise<void> | null = null;
  let releaseCreation = () => {};
  await page.route("https://library.test/api/**", async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/api/note-topics")
      return r.fulfill({ json: { topics, memberships: [] } });
    if (u.pathname === "/api/note-tags")
      return r.fulfill({
        json: ["독서 메모", "신앙", "관계", "전체 서재 태그"].map((tag) => ({
          tag,
          count: 1,
          activeCount: 1,
          fingerprint: "f",
        })),
      });
    if (u.pathname === "/api/thought-map" && r.request().method() === "POST") {
      const c = r.request().postDataJSON();
      commands.push(c);
      if (creationGate) await creationGate;
      if (failCreate)
        return r.fulfill({
          status: 503,
          json: { error: "검수용 주제 생성 실패" },
        });
      const t = { ...topics[0], id: crypto.randomUUID(), name: c.payload.name };
      topics.push(t);
      return r.fulfill({ json: { id: t.id, version: 1 } });
    }
    return r.fulfill({ json: { items: [], total: 0 } });
  });
  await page.route("https://library.test/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
    }),
  );
  await page.goto("https://library.test/");
  await page.evaluate((v) => Object.assign(window, v), {
    fixture,
    editor: editing ? { kind: "note", note } : { kind: "note" },
  });
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole("dialog")).toBeVisible();
  return {
    topics,
    commands,
    failCreation: () => {
      failCreate = true;
    },
    holdCreation: () => {
      creationGate = new Promise<void>((r) => {
        releaseCreation = r;
      });
      return () => {
        creationGate = null;
        releaseCreation();
      };
    },
  };
}
test("record heading scrolls away and typing/async refresh keep editor bounds stable", async ({
  page,
}) => {
  await mount(page);
  const dialog = page.getByRole("dialog", { name: "새로운 기록" });
  const before = (await dialog.boundingBox())!;
  await page.locator('textarea[name="content"]').fill("흔들림 없이 쓰는 기록");
  await page.evaluate(() => {
    (window as any).fixture = {
      ...(window as any).fixture,
      notes: [...(window as any).fixture.notes],
    };
    (window as any).rerender();
  });
  const after = (await dialog.boundingBox())!;
  expect(Math.abs(after.x - before.x)).toBeLessThan(1);
  expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  expect(Math.abs(after.height - before.height)).toBeLessThan(1);
  await dialog.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect(
    await dialog
      .locator("header")
      .evaluate((el) => getComputedStyle(el).position),
  ).toBe("static");
  const header = (await dialog.locator("header").boundingBox())!;
  expect(header.y + header.height).toBeLessThanOrEqual(before.y);
});
test("creates and selects a missing topic without losing the note; existing topics cannot be duplicated", async ({
  page,
}) => {
  const f = await mount(page);
  await page
    .locator('textarea[name="content"]')
    .fill("주제를 만드는 동안에도 보존할 내용");
  await page.locator(".note-topic-field summary").click();
  await page
    .getByRole("textbox", { name: "주제 찾기", exact: true })
    .fill("기존 주제");
  await expect(
    page.getByRole("button", { name: "주제 생성", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("textbox", { name: "주제 찾기", exact: true })
    .fill("새로운 사유");
  await page.getByRole("button", { name: "주제 생성", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "새로운 사유", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "저장하기", exact: true }).click();
  const saved = await page.evaluate(() => (window as any).saved);
  expect(saved.payload.content).toBe("주제를 만드는 동안에도 보존할 내용");
  expect(saved.payload.topicChanges).toContainEqual({
    topicId: f.topics.at(-1)!.id,
    status: "accepted",
    expectedVersion: 0,
  });
  expect(f.commands).toHaveLength(1);
});
test("topic creation failures preserve entered content and offer a retry", async ({
  page,
}) => {
  const f = await mount(page);
  f.failCreation();
  await page
    .locator('textarea[name="content"]')
    .fill("실패해도 사라지면 안 되는 글");
  await page.locator(".note-topic-field summary").click();
  await page
    .getByRole("textbox", { name: "주제 찾기", exact: true })
    .fill("연결 실패 주제");
  await page.getByRole("button", { name: "주제 생성", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("검수용 주제 생성 실패");
  await expect(page.locator('textarea[name="content"]')).toHaveValue(
    "실패해도 사라지면 안 되는 글",
  );
  await expect(
    page.getByRole("button", { name: "주제 생성", exact: true }),
  ).toBeEnabled();
});
test("saving waits for a new topic response but the note remains editable", async ({
  page,
}) => {
  const f = await mount(page),
    release = f.holdCreation();
  await page.locator('textarea[name="content"]').fill("기존 내용");
  await page.locator(".note-topic-field summary").click();
  await page
    .getByRole("textbox", { name: "주제 찾기", exact: true })
    .fill("응답 대기 주제");
  await page.getByRole("button", { name: "주제 생성", exact: true }).click();
  await expect.poll(() => f.commands.length).toBe(1);
  try {
    await expect(page.locator(".form-footer button.primary")).toBeDisabled();
    await page
      .locator('textarea[name="content"]')
      .fill("생성 중에도 계속 작성한 내용");
  } finally {
    release();
  }
  await expect(
    page.getByRole("checkbox", { name: "응답 대기 주제", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "저장하기", exact: true }).click();
  const saved = await page.evaluate(() => (window as any).saved);
  expect(saved.payload.content).toBe("생성 중에도 계속 작성한 내용");
  expect(saved.payload.topicChanges).toContainEqual({
    topicId: f.topics.at(-1)!.id,
    status: "accepted",
    expectedVersion: 0,
  });
});
test("tags open below the field, commit multiple choices with Apply and cancel draft changes", async ({
  page,
}) => {
  await mount(page, true);
  const toggle = page.getByRole("button", {
    name: "기록 태그 선택",
    exact: true,
  });
  await toggle.click();
  const field = (await toggle.boundingBox())!,
    list = (await page.locator(".note-tag-options").boundingBox())!;
  expect(Math.abs(field.x - list.x)).toBeLessThanOrEqual(1);
  expect(list.y).toBeGreaterThanOrEqual(field.y + field.height);
  await page.getByRole("checkbox", { name: "신앙", exact: true }).check();
  await page.getByRole("checkbox", { name: "관계", exact: true }).check();
  await expect(page.locator('input[name="tags"]')).toHaveValue("독서 메모");
  await page.getByRole("button", { name: "태그 적용", exact: true }).click();
  await expect(page.locator('input[name="tags"]')).toHaveValue(
    "독서 메모, 신앙, 관계",
  );
  await toggle.click();
  await page.getByRole("checkbox", { name: "관계", exact: true }).uncheck();
  await page.getByRole("button", { name: "태그 취소", exact: true }).click();
  await expect(page.locator('input[name="tags"]')).toHaveValue(
    "독서 메모, 신앙, 관계",
  );
  await toggle.click();
  await page
    .getByRole("searchbox", { name: "기록 태그 검색", exact: true })
    .fill("새 태그");
  await page.getByRole("button", { name: "태그 추가", exact: true }).click();
  await page.getByRole("button", { name: "태그 적용", exact: true }).click();
  await page.getByRole("button", { name: "저장하기", exact: true }).click();
  const saved = await page.evaluate(() => (window as any).saved);
  expect(saved.payload.tags).toEqual(["독서 메모", "신앙", "관계", "새 태그"]);
});
test("desktop tag picker cancels with Escape and preserves literal tag names", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(page, true);
  const dialog = page.getByRole("dialog", { name: "기록 수정", exact: true }),
    toggle = page.getByRole("button", { name: "기록 태그 선택", exact: true });
  await toggle.click();
  await expect(
    page.getByRole("checkbox", { name: "전체 서재 태그", exact: true }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: "신앙", exact: true }).check();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(page.locator('input[name="tags"]')).toHaveValue("독서 메모");
  await toggle.click();
  await page
    .getByRole("searchbox", { name: "기록 태그 검색", exact: true })
    .fill("쉼표, 포함");
  await page.getByRole("button", { name: "태그 추가", exact: true }).click();
  await dialog.screenshot({
    path: `.superpowers/sdd/2026-10-27-editor-whiteboard/editor-desktop-${info.project.name}.png`,
  });
  await page.getByRole("button", { name: "태그 적용", exact: true }).click();
  await page.getByRole("button", { name: "저장하기", exact: true }).click();
  expect(
    (await page.evaluate(() => (window as any).saved)).payload.tags,
  ).toEqual(["독서 메모", "쉼표, 포함"]);
});
