import { expect, it } from "vitest";
import { mergeAdoptedRelationships } from "../src/lib/assist-adoption-overlay";

it("shows exactly the adopted connection and shared thought bundle over a lagging device snapshot", () => {
  const connection = {
    id: "link-a", version: 1, source_kind: "note", target_kind: "note",
    source_id: "note-a", target_id: "note-b", status: "accepted",
    title: "공감과 경계", relation: "related", reason: "연결 근거",
  };
  const bundle = { id: "box-a", version: 1, title: "생각 묶음", note_ids: ["note-a","note-b"], archived_at: null };
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
  const changed = mergeAdoptedRelationships({
    ...earlier,
    connections: [{ ...connection, version: 2, status: "rejected" }],
  }, pending);
  expect(changed.connections[0].status).toBe("rejected");
  expect(earlier.connections).toHaveLength(1);
});
