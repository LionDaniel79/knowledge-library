import { it, expect } from "vitest";
import {
  pdfProgressFingerprint as key,
  pdfProgressReady as ready,
  pdfProgressResult as result,
} from "../src/local/curation/pdf-progress";
it("advances past cached results and revisits changed sources or expired results", () => {
  const b = { title: "Book", author: "A" },
    d = { signature: "1" },
    k = key(b, d, {}),
    p = result(undefined, k, "missing", 100);
  expect(ready(p, k, 101)).toBe(false);
  expect(ready(p, k, p.nextAttemptAt)).toBe(true);
  expect(ready(p, key({ ...b, title: "New" }, d, {}), 101)).toBe(true);
  expect(ready(p, key(b, { signature: "2" }, {}), 101)).toBe(true);
  expect(ready(p, key(b, d, {}, "new candidate"), 101)).toBe(true);
});
it("bounds resource retries and preserves state for restart", () => {
  let p = result(undefined, "k", "error", 100);
  expect(ready(p, "k", 101)).toBe(false);
  p = result(p, "k", "error", p.nextAttemptAt);
  p = result(p, "k", "error", p.nextAttemptAt);
  expect(p.attempts).toBe(3);
  expect(p.nextAttemptAt).toBeGreaterThan(86400000);
});
