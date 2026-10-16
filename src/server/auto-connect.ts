import { randomUUID } from "node:crypto";
import { createKnowledgeStore } from "./knowledge-store";
import type { Database } from "./library-store";
// Saving a note has already committed. Suggestion failure must never turn it into a failed save.
export async function suggestForSavedNote(
  db: Database,
  owner: string,
  id: string,
) {
  try {
    await createKnowledgeStore(db).mutate(owner, {
      requestId: randomUUID(),
      type: "suggest",
      payload: { kind: "note", id },
    });
    return true;
  } catch {
    return false;
  }
}
