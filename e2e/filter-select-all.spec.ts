import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { previewLibrary } from "../src/lib/preview-data";
import {
  buildTopicMaterials,
  pageTopicMaterials,
} from "../src/lib/topic-materials";

let bundle: string;
test.beforeAll(async () => {
  bundle = (
    await build({
      stdin: {
        contents: `
          import {createRoot} from 'react-dom/client';
          import {useState} from 'react';
          import {FacetPicker} from './src/components/whiteboard/facet-picker';
          import {TopicFilter} from './src/components/topic-filter';
          import {NoteTagFilter} from './src/components/note-tag-filter';
          import {NoteBookFilter} from './src/components/note-book-filter';
          import {TopicBrowser} from './src/components/thought-map/topic-browser';
          function App() {
            const [values, setValues] = useState(window.initialValues || []);
            const [options, setOptions] = useState(window.options);
            const [topics, setTopics] = useState(window.topics);
            const [applied, setApplied] = useState([]);
            window.refreshOptions = setOptions;
            window.refreshTopics = setTopics;
            if (window.mode === 'browser') return <TopicBrowser library={window.library} state={window.snapshot} send={async()=>null} busy={false} onOpen={()=>{}}/>;
            return <form onSubmit={e=>{e.preventDefault();setApplied(values)}}>
              {window.mode === 'facet' && <FacetPicker label="분야" options={options} values={values} onChange={setValues} selectAll multiple={!window.single}/>}
              {window.mode === 'topics' && <TopicFilter topics={topics} value="all" values={values} onChange={()=>{}} onValuesChange={setValues} selectAll onUpdated={async()=>{}}/>}
              {window.mode === 'tags' && <NoteTagFilter tags={window.tags} value="all" values={values} onChange={()=>{}} onValuesChange={setValues} selectAll searchable preview={false} onUpdated={async()=>{}}/>}
              {window.mode === 'books' && <NoteBookFilter library={window.library} value="all" values={values} onChange={()=>{}} onValuesChange={setValues}/>}
              <button type="submit">적용</button><output aria-label="적용된 선택">{JSON.stringify(applied)}</output>
            </form>
          }
          createRoot(document.getElementById('root')).render(<App/>);
        `,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
});

async function mount(
  page: Page,
  mode: string,
  fixture: Record<string, unknown> = {},
) {
  const topics = [
    {
      id: "00000000-0000-4000-8000-000000000001",
      name: "관계",
      version: 1,
      parentId: null,
      aliases: [],
      description: "",
      kdcCodes: [],
      confirmed: true,
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      name: "독서",
      version: 1,
      parentId: null,
      aliases: [],
      description: "",
      kdcCodes: [],
      confirmed: true,
    },
  ];
  const requests: { type: string; payload: Record<string, unknown> }[] = [];
  const remoteTags = { values: ["독서", "새 태그"] };
  await page.route("https://select-all.test/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/")
      return route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div></html>',
      });
    if (url.pathname === "/api/note-tags") {
      if (route.request().method() === "POST") {
        const command = route.request().postDataJSON();
        requests.push({ type: "deleteTag", payload: command });
        remoteTags.values = remoteTags.values.filter(
          (tag) => tag !== command.tag,
        );
        return route.fulfill({ json: { count: 1 } });
      }
      return route.fulfill({
        json: remoteTags.values.map((tag) => ({
          tag,
          count: 1,
          activeCount: 1,
          fingerprint: tag + "-hash",
        })),
      });
    }
    if (
      url.pathname === "/api/thought-map" &&
      route.request().method() === "POST"
    ) {
      const command = route.request().postDataJSON();
      requests.push(command);
      return route.fulfill({
        json: {
          id: command.type === "upsertTopic" ? "new-topic" : command.payload.id,
          version: 1,
        },
      });
    }
    return route.fulfill({ json: { items: [], total: 0 } });
  });
  await page.goto("https://select-all.test/");
  await page.evaluate((data) => Object.assign(window, data), {
    mode,
    options: [
      { value: "a", label: "분야 A" },
      { value: "b", label: "분야 B" },
    ],
    topics,
    tags: ["관계", "독서"],
    library: { ...previewLibrary, catalog: undefined },
    snapshot: {
      topics,
      memberships: [],
      topicLinks: [],
      events: [],
      notes: [
        { ...previewLibrary.notes[0], tags: ["관계"], kind: "note" },
        { ...previewLibrary.notes[1], tags: ["독서"], kind: "thought" },
      ],
    },
    ...fixture,
  });
  await page.addStyleTag({ path: "src/app/globals.css" });
  await page.addScriptTag({ content: bundle, type: "module" });
  await expect(page.locator("#root form").first()).toBeVisible();
  return { topics, requests, remoteTags };
}

test("selects every underlying facet through search and the 100-row limit, then excludes one and applies", async ({
  page,
}) => {
  await mount(page, "facet", {
    options: Array.from({ length: 105 }, (_, i) => ({
      value: String(i),
      label: `분야 ${i}`,
    })),
  });
  await page.getByRole("button", { name: "분야 선택", exact: true }).click();
  const all = page.getByRole("checkbox", { name: "전체 선택", exact: true });
  await expect(all).not.toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "분야 0", exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("textbox", { name: "분야 검색", exact: true })
    .fill("104");
  await all.check();
  await expect(
    page.getByRole("checkbox", { name: "분야 104", exact: true }),
  ).toBeChecked();
  await page.getByRole("checkbox", { name: "분야 104", exact: true }).uncheck();
  await expect(all).toBeChecked({ indeterminate: true });
  await page
    .getByRole("button", { name: "분야 선택 완료", exact: true })
    .click();
  await page.getByRole("button", { name: "적용", exact: true }).click();
  const selected = JSON.parse(
    await page.getByRole("status", { name: "적용된 선택" }).innerText(),
  );
  expect(selected).toHaveLength(104);
  expect(selected).toContain("0");
  expect(selected).toContain("103");
  expect(selected).not.toContain("104");
});

test("clearing explicit facet checks returns the empty unfiltered selection", async ({
  page,
}) => {
  await mount(page, "facet");
  await page.getByRole("button", { name: "분야 선택", exact: true }).click();
  const all = page.getByRole("checkbox", { name: "전체 선택", exact: true });
  await all.check();
  await all.uncheck();
  await expect(
    page.getByRole("checkbox", { name: "분야 A", exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("button", { name: "분야 선택 완료", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "분야 선택", exact: true }),
  ).toContainText("전체");
  await page.getByRole("button", { name: "적용", exact: true }).click();
  await expect(page.getByRole("status", { name: "적용된 선택" })).toHaveText(
    "[]",
  );
});

test("select all preserves selected IDs absent from refreshed options", async ({
  page,
}) => {
  await mount(page, "facet", { initialValues: ["b"] });
  await page.evaluate(() =>
    (window as any).refreshOptions([{ value: "a", label: "분야 A" }]),
  );
  await page.getByRole("button", { name: "분야 선택", exact: true }).click();
  await page.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
  await page
    .getByRole("button", { name: "분야 선택 완료", exact: true })
    .click();
  await page.getByRole("button", { name: "적용", exact: true }).click();
  await expect(page.getByRole("status", { name: "적용된 선택" })).toHaveText(
    '["b","a"]',
  );
});

test("book filters retain their original all sentinel and individual checks", async ({
  page,
}) => {
  await mount(page, "books");
  await page.getByRole("button", { name: "도서명 선택", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "전체 선택", exact: true }),
  ).toHaveCount(0);
  const all = page.getByRole("checkbox", { name: "전체", exact: true });
  await expect(all).toBeChecked();
  const book = page.getByRole("checkbox", {
    name: previewLibrary.books[0].title,
    exact: true,
  });
  await expect(book).not.toBeChecked();
  await book.check();
  await all.check();
  await expect(book).not.toBeChecked();
});

test("single-choice facets keep their original menu when select all is requested", async ({
  page,
}) => {
  await mount(page, "facet", { single: true });
  await page.getByRole("button", { name: "분야 선택", exact: true }).click();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await page.getByRole("option", { name: "분야 A", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "분야 선택", exact: true }),
  ).toContainText("분야 A");
});

test("tag select all includes untagged, source and loaded tags despite search, and preserves other selections on confirmed deletion", async ({
  page,
}) => {
  const fixture = await mount(page, "tags");
  await page.getByRole("button", { name: "태그 선택", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "태그 삭제 새 태그", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("searchbox", { name: "태그 검색", exact: true })
    .fill("관계");
  const all = page.getByRole("checkbox", { name: "전체 선택", exact: true });
  await all.check();
  await page.getByRole("checkbox", { name: "관계", exact: true }).uncheck();
  await expect(all).toBeChecked({ indeterminate: true });
  await page.getByRole("button", { name: "선택 완료", exact: true }).click();
  await page.getByRole("button", { name: "적용", exact: true }).click();
  const selected = JSON.parse(
    await page.getByRole("status", { name: "적용된 선택" }).innerText(),
  );
  expect(selected).toHaveLength(3);
  expect(selected).toEqual(
    expect.arrayContaining(["untagged", "독서", "새 태그"]),
  );
  await page.getByRole("button", { name: "태그 선택", exact: true }).click();
  await page
    .getByRole("button", { name: "태그 삭제 독서", exact: true })
    .click();
  expect(fixture.requests).toHaveLength(0);
  await page
    .getByRole("dialog", { name: "태그 삭제 확인", exact: true })
    .getByRole("button", { name: "태그 삭제", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "적용", exact: true }).click();
  const after = JSON.parse(
    await page.getByRole("status", { name: "적용된 선택" }).innerText(),
  );
  expect(after).toHaveLength(2);
  expect(after).toEqual(expect.arrayContaining(["untagged", "새 태그"]));
  await page.getByRole("button", { name: "태그 선택", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "독서", exact: true }),
  ).toHaveCount(0);
  await all.check();
  await all.uncheck();
  await page.getByRole("button", { name: "선택 완료", exact: true }).click();
  await page.getByRole("button", { name: "적용", exact: true }).click();
  await expect(page.getByRole("status", { name: "적용된 선택" })).toHaveText(
    "[]",
  );
});

test("topics retain checks through creation and only remove the confirmed deleted topic", async ({
  page,
}) => {
  const fixture = await mount(page, "topics");
  await page.getByRole("button", { name: "주제 선택", exact: true }).click();
  await page.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
  const search = page.getByRole("textbox", { name: "주제 검색", exact: true });
  await search.fill("새 주제");
  await page.getByRole("button", { name: "주제 생성", exact: true }).click();
  const created = page.getByRole("checkbox", { name: "새 주제", exact: true });
  await expect(created).not.toBeChecked();
  await created.check();
  await search.fill("");
  await page
    .getByRole("button", { name: "주제 삭제 관계", exact: true })
    .click();
  expect(
    fixture.requests.filter((request) => request.type === "deleteTopic"),
  ).toHaveLength(0);
  await page
    .getByRole("dialog", { name: "주제 삭제 확인", exact: true })
    .getByRole("button", { name: "주제 삭제", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "적용", exact: true }).click();
  const selected = JSON.parse(
    await page.getByRole("status", { name: "적용된 선택" }).innerText(),
  );
  expect(selected).toEqual(["unclassified", fixture.topics[1].id, "new-topic"]);
});

test("my-records filters opt in for kind, category, topic and tag while books and sort retain their behavior", async ({
  page,
}) => {
  await mount(page, "browser");
  const filters = page.locator(".unified-notes-filters");
  for (const label of ["종류", "도서 분야", "주제"]) {
    await filters
      .getByRole("button", { name: `${label} 선택`, exact: true })
      .click();
    await page
      .getByRole("checkbox", { name: "전체 선택", exact: true })
      .check();
    await page
      .getByRole("button", { name: `${label} 선택 완료`, exact: true })
      .click();
  }
  await filters.getByRole("button", { name: "태그 선택", exact: true }).click();
  await page.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
  await page.getByRole("checkbox", { name: "관계", exact: true }).uncheck();
  await page.getByRole("button", { name: "선택 완료", exact: true }).click();
  await filters.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.locator(".thought-card")).toHaveCount(1);
  await expect(page.locator(".thought-card")).toContainText(
    previewLibrary.notes[1].title!,
  );
  await filters.getByRole("button", { name: "태그 선택", exact: true }).click();
  await page.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
  await page
    .getByRole("checkbox", { name: "전체 선택", exact: true })
    .uncheck();
  await page.getByRole("button", { name: "선택 완료", exact: true }).click();
  await filters.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.locator(".thought-card")).toHaveCount(2);
  await filters
    .getByRole("button", { name: "도서명 선택", exact: true })
    .click();
  await expect(
    page.getByRole("checkbox", { name: "전체", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "전체 선택", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "도서명 선택 완료", exact: true })
    .click();
  await expect(filters.locator(".note-sort-filter select")).toHaveValue(
    "newest",
  );
  await expect(filters.locator(".note-sort-filter select")).not.toHaveAttribute(
    "multiple",
  );
});

for (const field of ["topics", "tags"] as const)
  test(`my-records applies more than 200 selected ${field} without losing the filter`, async ({
    page,
  }) => {
    const topics = Array.from({ length: 205 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: `주제 ${index}`,
      version: 1,
      parentId: null,
      aliases: [],
      description: "",
      kdcCodes: [],
      confirmed: true,
    }));
    const tags = Array.from({ length: 205 }, (_, index) => `태그 ${index}`);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mount(page, "browser", {
      snapshot: {
        topics,
        memberships: [],
        topicLinks: [],
        events: [],
        notes: [
          { ...previewLibrary.notes[0], tags, kind: "note" },
          { ...previewLibrary.notes[1], tags: [], kind: "thought" },
        ],
      },
    });
    const label = field === "topics" ? "주제" : "태그";
    const filters = page.locator(".unified-notes-filters");
    await filters
      .getByRole("button", { name: `${label} 선택`, exact: true })
      .click();
    await page
      .getByRole("checkbox", { name: "전체 선택", exact: true })
      .check();
    await page
      .getByRole("checkbox", { name: `${label} 0`, exact: true })
      .uncheck();
    await page
      .getByRole("button", {
        name: field === "topics" ? "주제 선택 완료" : "선택 완료",
        exact: true,
      })
      .click();
    await filters.getByRole("button", { name: "검색", exact: true }).click();
    await expect(page.locator(".thought-card")).toHaveCount(2);
    expect(errors).toEqual([]);
    await expect(
      filters.getByRole("button", { name: `${label} 선택`, exact: true }),
    ).toContainText("개 선택");
  });

test("my-records uses POST for long server filters and keeps exclusion and clear behavior", async ({
  page,
}) => {
  const topics = Array.from({ length: 400 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: `주제 ${index}`,
    version: 1,
    parentId: null,
    aliases: [],
    description: "",
    kdcCodes: [],
    confirmed: true,
  }));
  const notes = previewLibrary.notes.slice(0, 2);
  const memberships = [
    {
      topicId: topics[0].id,
      sourceKind: "note",
      sourceId: notes[0].id,
      status: "accepted",
    },
  ];
  const materials = buildTopicMaterials({
    books: previewLibrary.books,
    notes,
    topics,
    memberships,
  });
  const requests: { method: string; query: Record<string, string> }[] = [];
  await mount(page, "browser", {
    library: { ...previewLibrary, catalog: {} },
    snapshot: { topics, notes, memberships, topicLinks: [], events: [] },
  });
  await page.route(
    "https://select-all.test/api/library-materials**",
    async (route) => {
      const method = route.request().method();
      const query =
        method === "POST"
          ? route.request().postDataJSON()
          : Object.fromEntries(new URL(route.request().url()).searchParams);
      requests.push({ method, query });
      return route.fulfill({ json: pageTopicMaterials(materials, query) });
    },
  );
  const filters = page.locator(".unified-notes-filters");
  await filters.getByRole("button", { name: "주제 선택", exact: true }).click();
  await page.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
  await page.getByRole("checkbox", { name: "주제 0", exact: true }).uncheck();
  await page
    .getByRole("button", { name: "주제 선택 완료", exact: true })
    .click();
  await filters.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.locator(".thought-card")).toHaveCount(1);
  await expect(page.locator(".thought-card")).toContainText(notes[1].title!);
  expect(requests.at(-1)?.method).toBe("POST");
  const selected = JSON.parse(requests.at(-1)!.query.topics);
  expect(selected).toHaveLength(400);
  expect(selected).not.toContain(topics[0].id);
  expect(selected).toContain("unclassified");
  await filters.getByRole("button", { name: "주제 선택", exact: true }).click();
  await page.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
  await page
    .getByRole("checkbox", { name: "전체 선택", exact: true })
    .uncheck();
  await page
    .getByRole("button", { name: "주제 선택 완료", exact: true })
    .click();
  await filters.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.locator(".thought-card")).toHaveCount(2);
  expect(requests.at(-1)?.method).toBe("GET");
});
