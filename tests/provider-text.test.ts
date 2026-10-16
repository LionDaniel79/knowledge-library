import { expect, it } from "vitest";
import { providerText, displayProviderText } from "../src/lib/provider-text";
import { parseLibraryResult } from "../src/server/catalog-provider";
import { parseGoogleBooks } from "../src/local/curation/catalog";

it("reads provider descriptions as text, decoding named and numeric entities", () => {
  const html =
    "<p>상담&nbsp;&amp; 철학</p><p>&ldquo;이해&rdquo; &#xC0AC;&#50976;</p><script>bad()</script>";
  expect(providerText(html)).toBe("상담 & 철학 “이해” 사유");
  expect(providerText("A &#999999999; &#xD800; &unknown;")).toBe(
    "A &#999999999; &#xD800; &unknown;",
  );
  expect(providerText("&lt;em&gt;문장&lt;/em&gt;")).toBe("<em>문장</em>");
});

it("decodes legacy entities once and never reinterprets normalized or human text", () => {
  const base = {
    origin: "provider",
    reviewed_by: null,
    value: "&lt;주의&gt; 본문 &amp;quot;표기&amp;quot;",
    generator: "Google Books/v1",
  };
  expect(displayProviderText(base)).toBe("<주의> 본문 &quot;표기&quot;");
  expect(
    displayProviderText({
      ...base,
      value: "<주의> 본문 &quot;표기&quot;",
      generator: "Google Books/plain-text-v1",
    }),
  ).toBe("<주의> 본문 &quot;표기&quot;");
  expect(displayProviderText({ ...base, reviewed_by: "human" })).toBe(
    base.value,
  );
});
it("applies the same text rules to library and Google collection", () => {
  const isbn = "9780306406157",
    description = "<p>생각 &amp; &quot;질문&quot;</p>";
  expect(
    parseLibraryResult(
      { response: { detail: [{ book: { isbn13: isbn, description } }] } },
      isbn,
    )?.description,
  ).toBe('생각 & "질문"');
  expect(
    parseGoogleBooks(
      {
        items: [
          {
            id: "book",
            volumeInfo: {
              industryIdentifiers: [{ identifier: isbn }],
              description,
            },
          },
        ],
      },
      isbn,
    )?.description,
  ).toBe('생각 & "질문"');
});
