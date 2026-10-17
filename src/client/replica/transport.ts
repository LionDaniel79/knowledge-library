import { z } from "zod";
import { syncCommandEnvelope } from "../../lib/replica/command-envelope";
import {
  syncEntity,
  syncPage,
  syncRevision,
  MAX_JSON_RESPONSE_BYTES,
  VALUE_PART_BYTES,
  type SyncPage,
  type SyncRow,
  type OutboxEntry,
} from "../../lib/replica/contracts";
import type { SyncEntity } from "../../lib/replica/entities";
const stats = z
  .object({
    rows: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  })
  .strict();
const metaInput = z
  .object({
    epoch: z.string().uuid(),
    head: syncRevision,
    floor: syncRevision,
    protocol: z.literal(1),
    entities: z.record(syncEntity, stats).or(z.object({}).strict()),
    totalRows: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
  })
  .strict();
const coverageInput = z
  .object({
    epoch: z.string().uuid(),
    head: syncRevision,
    entities: z.record(
      syncEntity,
      z
        .object({
          rows: z.number().int().nonnegative(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
  })
  .strict();
export type SyncMeta = z.infer<typeof metaInput>;
export type ReplicaCoverage = z.infer<typeof coverageInput>;
export interface SyncTransport {
  push?(entry: OutboxEntry, signal?: AbortSignal): Promise<unknown>;
  meta(inventory?: boolean, signal?: AbortSignal): Promise<SyncMeta>;
  scan(
    entity: SyncEntity,
    after?: string,
    signal?: AbortSignal,
  ): Promise<SyncPage>;
  changes(
    epoch: string,
    cursor: string,
    signal?: AbortSignal,
  ): Promise<SyncPage>;
  value(row: SyncRow, index: number, signal?: AbortSignal): Promise<Uint8Array>;
  coverage(signal?: AbortSignal): Promise<ReplicaCoverage>;
}
export class SyncHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "SyncHttpError";
  }
}
async function boundedBody(response: Response, max: number) {
  if (Number(response.headers.get("Content-Length") ?? 0) > max)
    throw new SyncHttpError(413, "동기화 응답이 너무 큽니다.");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new SyncHttpError(413, "동기화 응답이 너무 큽니다.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
export function createSyncTransport(
  baseUrl = "",
  fetcher: typeof fetch = fetch,
  owner?: string,
): SyncTransport {
  const root = baseUrl.replace(/\/$/, "");
  if (root) {
    const u = new URL(root);
    if (
      (u.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) ||
      (typeof location !== "undefined" && u.origin !== location.origin)
    )
      throw Error("같은 서재 주소에서 동기화해 주세요.");
  }
  let sessionChecked = -Infinity,
    sessionCheck: Promise<void> | null = null;
  async function ensureSession(signal?: AbortSignal, force = false) {
    if (!owner || (!force && Date.now() - sessionChecked < 60000)) return;
    if (!sessionCheck)
      sessionCheck = (async () => {
        // The SDK handler renews its signed local session cache from the existing
        // HttpOnly login token. Business getSession() alone does not renew it.
        const response = await fetcher(root + "/api/auth/get-session", {
          cache: "no-store",
          credentials: "same-origin",
          redirect: "error",
          signal,
        });
        const bytes = await boundedBody(response, MAX_JSON_RESPONSE_BYTES);
        if (!response.ok)
          throw new SyncHttpError(
            response.status,
            "로그인 연결을 확인한 뒤 동기화를 재개해 주세요.",
          );
        const session = JSON.parse(new TextDecoder().decode(bytes));
        if (!session?.session || typeof session?.user?.id !== "string")
          throw new SyncHttpError(401, "Google 계정으로 다시 로그인해 주세요.");
        if (session.user.id !== owner)
          throw new SyncHttpError(403, "로그인한 서재 계정이 변경되었습니다.");
        sessionChecked = Date.now();
      })().finally(() => {
        sessionCheck = null;
      });
    await sessionCheck;
  }
  async function authenticatedFetch(
    input: RequestInfo | URL,
    init: RequestInit,
  ) {
    await ensureSession(init.signal ?? undefined);
    let response = await fetcher(input, init);
    if (owner && response.status === 401) {
      await response.body?.cancel();
      await ensureSession(init.signal ?? undefined, true);
      response = await fetcher(input, init);
    }
    return response;
  }
  async function get(
    path: string,
    params: Record<string, string> = {},
    signal?: AbortSignal,
    binary = false,
  ) {
    const response = await authenticatedFetch(
      root + "/api/sync/" + path + "?" + new URLSearchParams(params),
      {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal,
      },
    );
    const bytes = await boundedBody(
      response,
      binary && response.ok ? VALUE_PART_BYTES : MAX_JSON_RESPONSE_BYTES,
    );
    if (!response.ok) {
      let message = "동기화 연결을 확인해 주세요.";
      try {
        const body = JSON.parse(new TextDecoder().decode(bytes));
        if (typeof body.error === "string") message = body.error.slice(0, 500);
      } catch {}
      throw new SyncHttpError(response.status, message);
    }
    if (binary) return bytes;
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw new SyncHttpError(401, "서재에 다시 로그인해 주세요.");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
  return {
    async push(entry, signal) {
      const response = await authenticatedFetch(root + "/api/sync/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(syncCommandEnvelope(entry)),
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal,
      });
      const bytes = await boundedBody(response, MAX_JSON_RESPONSE_BYTES);
      let value: any;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        throw new SyncHttpError(
          response.status === 200 ? 502 : response.status,
          "전송 결과를 확인하지 못했습니다. 입력은 보관됩니다.",
        );
      }
      if (!response.ok)
        throw new SyncHttpError(
          response.status,
          typeof value.error === "string"
            ? value.error
            : "변경 내용을 확인해 주세요.",
        );
      return value;
    },
    meta: async (inventory = true, signal) =>
      metaInput.parse(
        await get("meta", { inventory: inventory ? "1" : "0" }, signal),
      ),
    scan: async (entity, after, signal) =>
      syncPage.parse(
        await get(
          "scan",
          { entity, limit: "200", ...(after ? { after } : {}) },
          signal,
        ),
      ),
    changes: async (epoch, cursor, signal) =>
      syncPage.parse(
        await get("changes", { epoch, cursor, limit: "200" }, signal),
      ),
    value: async (row, index, signal) =>
      get(
        "value",
        {
          entity: row.entity,
          key: row.key,
          revision: row.revision,
          index: String(index),
        },
        signal,
        true,
      ),
    coverage: async (signal) =>
      coverageInput.parse(await get("coverage", {}, signal)),
  };
}
