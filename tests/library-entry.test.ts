import { it, expect } from "vitest";
import { libraryEntry, authReturnPath } from "../src/lib/library-entry";
import { pcLibraryUrl } from "../src/lib/pc-access";
it("selects only the known PDF entry and builds private PC links to its search or status screen", () => {
  expect(pcLibraryUrl("https://library.example.ts.net")).toBe(
    "https://library.example.ts.net/?view=pdf",
  );
  expect(pcLibraryUrl("https://library.example.ts.net", true)).toBe(
    "https://library.example.ts.net/?view=pdf&panel=operations",
  );
  expect(() => pcLibraryUrl("https://evil.example")).toThrow();
  expect(libraryEntry({ view: "pdf", panel: "operations" })).toEqual({
    view: "pdf",
    operations: true,
    path: "/?view=pdf&panel=operations",
  });
  expect(
    libraryEntry({ view: "https://evil.example", panel: "operations" }),
  ).toEqual({ view: "home", operations: false, path: "/" });
});
it("retains PDF and validated consent destinations while refusing arbitrary login return locations", () => {
  for (const path of [
    "/?view=pdf",
    "/?view=pdf&panel=operations",
    "/connect/mcp?state=test",
  ])
    expect(authReturnPath(path)).toBe(path);
  for (const path of [
    "//evil.example",
    "https://evil.example",
    "/\\evil.example",
    "/?view=pdf&redirect=https://evil.example",
    "/reader/not-a-valid-id",
  ])
    expect(authReturnPath(path)).toBe("/");
});
it("returns to the exact PDF and citation after private-PC login, allowing no other redirect parameters", () => {
  const path =
    "/reader/11111111-1111-4111-8111-111111111111?page=42&signature=abc%3A123";
  expect(authReturnPath(path)).toBe(path);
  for (const bad of [
    path + "&next=https://evil.example",
    path + "#bad",
    path.replace("page=42", "page=100001"),
    path.replace("page=42", "page=0"),
  ])
    expect(authReturnPath(bad)).toBe("/");
});
