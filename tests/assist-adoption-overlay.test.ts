import { expect, it } from "vitest";
import {
  mergeAdoptedRelationships,
  rememberConfirmedRelationship,
  confirmedRelationships,
  releaseConfirmedRelationships,
} from "../src/lib/assist-adoption-overlay";

it("shows exactly the adopted connection and shared thought bundle over a lagging device snapshot", () => {
  const connection = {
    id: "link-a",
    version: 1,
    source_kind: "note",
    target_kind: "note",
    source_id: "note-a",
    target_id: "note-b",
    status: "accepted",
    title: "공감과 경계",
    relation: "related",
    reason: "연결 근거",
  };
  const bundle = {
    id: "box-a",
    version: 1,
    title: "생각 묶음",
    note_ids: ["note-a", "note-b"],
    archived_at: null,
  };
  const pending = {
    connections: new Map([[connection.id, connection]]),
    bundles: new Map([[bundle.id, bundle]]),
  };
  const earlier = {
    notes: [{ id: "note-a" }, { id: "note-b" }],
    connections: [{ id: "unrelated", version: 1, status: "accepted" }],
    bundles: [],
  };
  const result = mergeAdoptedRelationships(earlier, pending);
  expect(result.connections.map((c) => c.id)).toEqual(["unrelated", "link-a"]);
  expect(result.bundles).toEqual([bundle]);
  const repeated = mergeAdoptedRelationships(result, pending);
  expect(repeated.connections).toHaveLength(2);
  expect(repeated.bundles).toHaveLength(1);
  const changed = mergeAdoptedRelationships(
    {
      ...earlier,
      connections: [{ ...connection, version: 2, status: "rejected" }],
    },
    pending,
  );
  expect(changed.connections[0].status).toBe("rejected");
  expect(earlier.connections).toHaveLength(1);
});

it("preserves selected link between component mounts but keeps other account rows isolated", () => {
  const owner = "test-owner-navigation";
  const other = "test-other-owner";
  releaseConfirmedRelationships(owner);
  releaseConfirmedRelationships(other);
  rememberConfirmedRelationship(owner, {
    connection: { id: "link-navigation", version: 1, status: "accepted" },
  });
  expect(confirmedRelationships(other)?.connections.size).toBe(0);
  const mountedAfterNavigation = confirmedRelationships(owner)!;
  expect(
    mergeAdoptedRelationships(
      { connections: [], bundles: [] },
      mountedAfterNavigation,
    ).connections,
  ).toEqual([{ id: "link-navigation", version: 1, status: "accepted" }]);
  releaseConfirmedRelationships(owner);
  releaseConfirmedRelationships(other);
});

it("retains a newer confirmed row when a retry returns an older canonical version", () => {
  const owner = "test-retry-version";
  releaseConfirmedRelationships(owner);
  rememberConfirmedRelationship(owner, {
    connection: { id: "same", version: 3, title: "new" },
  });
  rememberConfirmedRelationship(owner, {
    connection: { id: "same", version: 1, title: "old" },
  });
  expect(confirmedRelationships(owner)!.connections.get("same")!.title).toBe(
    "new",
  );
  releaseConfirmedRelationships(owner);
});
