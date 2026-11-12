import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { CatalogAttribution } from "../src/components/catalog-attribution";
const enrichment = {
  autoBibliography: {
    provider: "예스24",
    url: "https://www.yes24.com/product/goods/123",
    fields: ["coverUrl", "description", "toc"],
  },
  auto_description: "Saved introduction",
  auto_toc: ["First chapter"],
  auto_publicationYear: "2024",
};
it("displays adopted metadata and provider credit without replacing manual selections", () => {
  const html = renderToStaticMarkup(
    createElement(CatalogAttribution, {
      value: undefined,
      automatic: enrichment,
    }),
  );
  expect(html).toContain("Saved introduction");
  expect(html).toContain("First chapter");
  expect(html).toContain("2024");
  expect(html).toContain("예스24");
  expect(
    renderToStaticMarkup(
      createElement(CatalogAttribution, {
        value: undefined,
        automatic: enrichment,
        compact: true,
      }),
    ),
  ).toContain("예스24");
  expect(
    renderToStaticMarkup(
      createElement(CatalogAttribution, {
        value: undefined,
        automatic: {
          ...enrichment,
          autoBibliography: { ...enrichment.autoBibliography, fields: [] },
        },
      }),
    ),
  ).toBe("");
});
