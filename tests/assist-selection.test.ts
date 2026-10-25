import { it, expect } from "vitest";
import {
  analysisExcerpt,
  representativeNotes,
} from "../src/lib/assist-selection";
it("balances topics and includes older material rather than taking only the newest page", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    topicIds: [i < 20 ? "a" : "b"],
    category: "",
    bookId: null,
  })) as any;
  const chosen = representativeNotes(rows, 4, "2");
  expect(chosen.map((n) => n.id)).toEqual(["2", "0", "20", "19"]);
  expect(new Set(chosen.map((n) => n.id)).size).toBe(4);
});
it("locates the actual matching passage and preserves original offsets", () => {
  const text = "앞 문장 ".repeat(200) + "찾을핵심문장" + " 뒤 문장".repeat(200),
    selection = analysisExcerpt(text, "찾을핵심문장", 500)!;
  expect(text.slice(selection.start, selection.end)).toContain("찾을핵심문장");
  expect(selection.end - selection.start).toBeLessThanOrEqual(500);
  expect(analysisExcerpt("짧은 기록", "", 500)).toBeUndefined();
});
