import { expect, it } from "vitest";
import { evaluateLibraryAcceptance } from "../src/local/curation/acceptance";

const input = () => ({
  curation: Array.from({ length: 60 }, (_, i) => ({
    id: `c${i}`,
    verdict: "pending",
    reviewer: null,
  })),
  comparisons: Array.from({ length: 30 }, (_, i) => ({
    id: `p${i}`,
    verdict: "pending",
    reviewer: null,
    task: null,
    result: null,
  })),
  queries: Array.from({ length: 20 }, (_, i) => ({
    id: `q${i}`,
    group: "within",
    query: "정서",
    reviewed: false,
    personalRelevantIds: [],
    baselineIds: [],
    currentIds: [],
  })),
  preservation: {
    before: { notes: "same", cycles: "same" },
    after: { notes: "same", cycles: "same" },
  },
});
it("keeps unreviewed samples and absent API trials pending, never passing on generated labels", () => {
  const data = input();
  const r = evaluateLibraryAcceptance(data);
  expect(r.curation).toMatchObject({
    total: 60,
    pending: 60,
    useful: 0,
    expand: false,
  });
  expect(r.comparisons).toMatchObject({
    total: 30,
    executed: 0,
    enable: false,
    actualCostUsd: "0.000000000",
  });
  expect(r.retrieval).toMatchObject({
    recallBefore: null,
    recallAfter: null,
    enableAuxBoost: false,
  });
  expect(() =>
    evaluateLibraryAcceptance({
      ...data,
      curation: data.curation.map((x) => ({
        ...x,
        verdict: "useful",
        reviewer: "codex",
      })),
    }),
  ).toThrow();
});
it("requires complete human review, unchanged source hashes and all query groups before opening gates", () => {
  const data: any = input();
  data.curation = data.curation.map((x: any, i: number) => ({
    ...x,
    verdict: i < 54 ? "useful" : "not_useful",
    reviewer: "human",
  }));
  expect(evaluateLibraryAcceptance(data).curation.expand).toBe(true);
  data.preservation.after.notes = "changed";
  expect(evaluateLibraryAcceptance(data).curation.expand).toBe(false);
  data.preservation.after.notes = "same";
  data.queries = data.queries.map((q: any, i: number) => ({
    ...q,
    group: ["within", "cross", "unclassified", "counterargument", "paper"][
      i % 5
    ],
    reviewed: true,
    personalRelevantIds: ["n1", "n2"],
    baselineIds: ["n1", "n2"],
    currentIds: ["n1"],
  }));
  expect(evaluateLibraryAcceptance(data).retrieval).toMatchObject({
    recallBefore: 1,
    recallAfter: 0.5,
    enableAuxBoost: false,
  });
  data.queries.forEach((q: any) => {
    q.currentIds = ["n1", "n2", "n2"];
  });
  expect(evaluateLibraryAcceptance(data).retrieval.enableAuxBoost).toBe(true);
  data.curation[59] = data.curation[0];
  expect(() => evaluateLibraryAcceptance(data)).toThrow("중복");
});
