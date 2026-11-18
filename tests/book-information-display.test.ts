import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CatalogAttribution } from "../src/components/catalog-attribution";
it("shows manually selected Logos introduction and toc without an automatic application", () => {
  const automatic = {
    auto_description: "Selected intro",
    auto_toc: ["Selected chapter"],
    catalogReviewSelection: {
      provider: "예스24",
      url: "https://www.yes24.com/product/goods/1",
      fields: ["description", "toc"],
    },
  };
  const html = renderToStaticMarkup(
    createElement(CatalogAttribution, {
      value: null,
      automatic,
      section: "introduction",
    }),
  );
  expect(html).toContain("Selected intro");
  expect(html).toContain("Selected chapter");
  expect(html).toContain("예스24");
});
