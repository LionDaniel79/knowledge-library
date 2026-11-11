import { it, expect } from "vitest";
import { libraryEntry, authReturnPath } from "../src/lib/library-entry";

it("opens only book metadata for legacy PDF bookmarks and discards retired search and operations destinations", () => {
  for (const query of [
    { view: "pdf" },
    { view: "pdf", panel: "operations" },
    { view: "pdf", panel: "folder" },
    { view: "pdf", pdfMode: "search", pdfQuery: "private text" },
  ])
    expect(libraryEntry(query)).toEqual({ view: "books", path: "/" });
  for (const query of [
    {},
    { view: "https://evil.example" },
    { view: ["pdf", "home"] },
  ])
    expect(libraryEntry(query)).toEqual({ view: "home", path: "/" });
});

it("keeps consent destinations and rejects retired PDF and arbitrary login return locations", () => {
  expect(authReturnPath("/connect/mcp?state=test")).toBe(
    "/connect/mcp?state=test",
  );
  for (const path of [
    "/",
    "/?view=pdf",
    "/?view=pdf&panel=operations",
    "/?view=pdf&panel=folder",
    "/?view=pdf&pdfMode=search&pdfQuery=private",
    "/reader/11111111-1111-4111-8111-111111111111?page=42&signature=abc%3A123",
    "//evil.example",
    "https://evil.example",
    "/\\evil.example",
    "/?view=pdf&redirect=https://evil.example",
    "/reader/not-a-valid-id",
  ])
    expect(authReturnPath(path)).toBe("/");
});
