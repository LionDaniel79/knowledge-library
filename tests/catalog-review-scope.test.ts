import { expect, it } from "vitest";
import {
  candidateDiscoveryAllowed,
  filterOwnedPdfHits,
} from "../src/local/curation/review-scope";
it("checks current owner, book version and both current PDF scopes before sending cached titles", () => {
  const cached = {
    bookId: "b",
    bookVersion: 3,
    documentId: "d",
    title: "제목-저자",
    evidence: { signature: "sig", processingScope: "full" },
  };
  const current = {
    owner_id: "owner",
    id: "b",
    version: 3,
    title: "제목-저자",
    documentId: "d",
    processing_scope: "full",
  };
  const local = {
    id: "d",
    signature: "sig",
    processing_scope: "full",
    status: "ocr_review",
  };
  expect(candidateDiscoveryAllowed("owner", cached, current, local)).toBe(true);
  for (const change of [
    { owner_id: "other" },
    { version: 4 },
    { processing_scope: "metadata_only" },
    { documentId: "other" },
    { title: "changed" },
  ])
    expect(
      candidateDiscoveryAllowed(
        "owner",
        cached,
        { ...current, ...change },
        local,
      ),
    ).toBe(false);
  for (const change of [
    { signature: "changed" },
    { processing_scope: "metadata_only" },
    { status: "error" },
  ])
    expect(
      candidateDiscoveryAllowed("owner", cached, current, {
        ...local,
        ...change,
      }),
    ).toBe(false);
  expect(
    candidateDiscoveryAllowed(
      "owner",
      { ...cached, title: null },
      current,
      local,
    ),
  ).toBe(false);
});
it("checks real search pages only when both document and book belong to this owner", () => {
  const hits = [
    { documentId: "owned" },
    { documentId: "foreign" },
    { documentId: "unlinked" },
    { documentId: "paper" },
    { documentId: "wrong-book" },
  ];
  const docs = [
    {
      id: "owned",
      owner_id: "me",
      book_owner_id: "me",
      processing_scope: "full",
    },
    {
      id: "foreign",
      owner_id: "other",
      book_owner_id: "other",
      processing_scope: "full",
    },
    {
      id: "paper",
      owner_id: "me",
      book_owner_id: "me",
      processing_scope: "metadata_only",
    },
    {
      id: "wrong-book",
      owner_id: "me",
      book_owner_id: "other",
      processing_scope: "full",
    },
  ];
  expect(filterOwnedPdfHits("me", hits, docs)).toEqual([
    { documentId: "owned" },
  ]);
});
