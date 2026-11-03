import { expect, test } from "@playwright/test";
import { build } from "esbuild";

test("Logos Excel XML selects only exact 성경 주석 and 단행본 resource types", async ({
  page,
}) => {
  const script = (
    await build({
      stdin: {
        contents: `import { parseLogosXmlSelection } from './src/lib/logos-xml'; window.selectLogos = parseLogosXmlSelection;`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
    })
  ).outputFiles[0].text;
  await page.route("https://logos-selection.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body>Logos selection fixture</body></html>",
    }),
  );
  await page.goto("https://logos-selection.test/");
  await page.addScriptTag({ content: script });
  const ns = "urn:schemas-microsoft-com:office:spreadsheet";
  const columns = [
    "Resource ID",
    "Title",
    "Authors",
    "Publishers",
    "License",
    "Resource Type",
  ];
  const row = (fields: string[]) =>
    "<Row>" +
    fields.map((x) => "<Cell><Data>" + x + "</Data></Cell>").join("") +
    "</Row>";
  const xml = `<?xml version="1.0" encoding="utf-8"?>
    <Workbook xmlns="${ns}"><Worksheet><Table>
      ${row(columns)}
      ${row(["LLS:COMMENTARY", "A commentary", "Author", "Publisher", "영구 소유", "성경 주석"])}
      ${row(["LLS:MONOGRAPH", "A monograph", "Author", "Publisher", "임시 소유", "단행본"])}
      ${row(["LLS:GENERIC", "Other commentary", "Author", "Publisher", "영구 소유", "주석"])}
      ${row(["LLS:SERMON", "Sermon", "Author", "Publisher", "영구 소유", "설교"])}
    </Table></Worksheet></Workbook>`;
  const result = await page.evaluate(
    (source) => (window as any).selectLogos(source),
    xml,
  );
  expect(result).toMatchObject({ total: 4, excluded: 2 });
  expect(result.items.map((i: { resourceId: string }) => i.resourceId)).toEqual(
    ["LLS:COMMENTARY", "LLS:MONOGRAPH"],
  );
});
