import { z } from "zod";
import { requireOwner } from "../auth";
import { database } from "../db";
import { failure } from "../http";
import { LibraryError } from "../library-store";
import {
  syncEntity,
  syncKeyInput,
  syncRevision,
} from "../../lib/replica/contracts";
import { syncInput } from "./registry";
import { readSyncMeta, readSyncChanges, scanSyncRows } from "./read";
import { readSyncValuePart } from "./values";
import { readSyncCoverage } from "./coverage";
const limit = z.coerce.number().int().min(1).max(200).optional();
const schemas = {
  coverage: z.object({}).strict(),
  meta: z.object({ inventory: z.enum(["0", "1"]).optional() }).strict(),
  scan: z
    .object({
      entity: syncEntity,
      after: z.string().max(8192).optional(),
      limit,
    })
    .strict(),
  changes: z
    .object({
      epoch: z.string().uuid(),
      cursor: z.string().min(1).max(8192),
      limit,
    })
    .strict(),
  value: z
    .object({
      entity: syncEntity,
      key: syncKeyInput,
      revision: syncRevision,
      index: z.coerce.number().int().min(0).max(5999),
    })
    .strict(),
};
export async function syncGet(kind: keyof typeof schemas, request: Request) {
  let response: Response;
  try {
    const owner = await requireOwner(),
      url = new URL(request.url),
      params: Record<string, string> = Object.create(null);
    if (url.search.length > 16384)
      throw new LibraryError(400, "동기화 요청이 너무 깁니다.");
    for (const [key, value] of url.searchParams) {
      if (Object.hasOwn(params, key))
        throw new LibraryError(400, "동기화 요청이 중복됐습니다.");
      params[key] = value;
    }
    // Each branch has its own strict input boundary. The request never supplies an owner.
    switch (kind) {
      case "coverage":
        syncInput(schemas.coverage, params);
        response = Response.json(await readSyncCoverage(database, owner));
        break;
      case "meta": {
        const v = syncInput(schemas.meta, params);
        response = Response.json(
          await readSyncMeta(database, owner, v.inventory !== "0"),
        );
        break;
      }
      case "scan":
        response = Response.json(
          await scanSyncRows(database, owner, syncInput(schemas.scan, params)),
        );
        break;
      case "changes":
        response = Response.json(
          await readSyncChanges(
            database,
            owner,
            syncInput(schemas.changes, params),
          ),
        );
        break;
      case "value": {
        const bytes = await readSyncValuePart(
          database,
          owner,
          syncInput(schemas.value, params),
        );
        response = new Response(new Uint8Array(bytes), {
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Content-Type-Options": "nosniff",
          },
        });
        break;
      }
    }
  } catch (error) {
    response = failure(error);
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
