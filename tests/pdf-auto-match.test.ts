import { it, expect } from "vitest";
import { decideAutomaticCandidate } from "../src/local/curation/logos-discovery";
it("accepts PDF ISBN corroboration across script variants but rejects different volumes and authors", () => {
  const b: any = {
    formats: ["pdf"],
    title: "장로교회사(오덕교)",
    author: "Deok Kyo Oh",
    publisher: "",
    isbn: "9788986191707",
  };
  const r: any = {
    isbn: b.isbn,
    facts: {
      title: "장로교회사=(A)history of the Presbyterians",
      author: "오덕교 지음",
      publisher: "",
      isbn: b.isbn,
    },
  };
  expect(decideAutomaticCandidate(b, [r]).state).toBe("certain");
  expect(
    decideAutomaticCandidate({ ...b, author: "John Smith" }, [
      { ...r, facts: { ...r.facts, author: "Mary Brown" } },
    ]).state,
  ).toBe("missing");
  expect(
    decideAutomaticCandidate({ ...b, title: "장로교회사 1" }, [
      { ...r, facts: { ...r.facts, title: "장로교회사 2" } },
    ]).state,
  ).toBe("missing");
});
