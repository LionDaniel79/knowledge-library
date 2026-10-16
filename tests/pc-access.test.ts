import { expect, it } from "vitest";
import { privatePcOrigin, pcDocumentUrl } from "../src/lib/pc-access";
it("accepts only configured private Tailscale HTTPS origins, never credentials or paths", () => {
  expect(privatePcOrigin("https://library.example.ts.net")).toBe(
    "https://library.example.ts.net",
  );
  for (const value of [
    "http://library.example.ts.net",
    "https://evil.example",
    "https://x.ts.net.evil.example",
    "https://u:p@library.example.ts.net",
    "https://library.example.ts.net/a",
    "https://library.example.ts.net/?key=a",
  ])
    expect(privatePcOrigin(value)).toBeNull();
});
it("retains document identity, citation page and signature in the PC link", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const url = pcDocumentUrl(
    "https://library.example.ts.net",
    id,
    42,
    "abc:123",
  );
  expect(url).toBe(
    `https://library.example.ts.net/reader/${id}?page=42&signature=abc%3A123`,
  );
  expect(() => pcDocumentUrl("https://evil.example", id, 42)).toThrow();
  expect(() =>
    pcDocumentUrl("https://library.example.ts.net", "../file", 42),
  ).toThrow();
});
