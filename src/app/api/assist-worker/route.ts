import { z } from "zod";
import { database } from "@/server/db";
import { createDeviceAuth } from "@/server/thought-device-auth";
import { createAssistStore } from "@/server/assist-store";
import { LibraryError } from "@/server/library-store";
import { failure } from "@/server/http";
import { after } from "next/server";
import {
  processServerAssist,
  serverAssistConfig,
} from "@/server/server-assist";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const lease = { id: z.string().uuid(), leaseToken: z.string().uuid() };
const schema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("heartbeat"),
      keyReady: z.boolean(),
      priceVersion: z.string().max(100),
    })
    .strict(),
  z.object({ action: z.literal("claim") }).strict(),
  ...(["begin", "renew", "failClaim"] as const).map((action) =>
    z.object({ action: z.literal(action), ...lease }).strict(),
  ),
  z
    .object({ action: z.literal("finish"), ...lease, result: z.unknown() })
    .strict(),
]);
export async function POST(request: Request) {
  try {
    const d = await createDeviceAuth(database).authenticate(
      request.headers.get("Authorization") ?? "",
    );
    const body = await request.text();
    if (Buffer.byteLength(body) > 100000)
      throw new LibraryError(413, "결과가 너무 큽니다.");
    let raw;
    try {
      raw = JSON.parse(body);
    } catch {
      throw new LibraryError(400, "요청 형식 오류");
    }
    const p = schema.parse(raw),
      s = createAssistStore(database);
    let result;
    if (p.action === "claim" && serverAssistConfig().ready) {
      // Existing PC brokers may still submit/observe requests. Server mode owns new work.
      after(async () => {
        try {
          await processServerAssist(database, d.ownerId);
        } catch {
          console.warn("AI 요청 연결·결과 저장을 확인해 주세요.");
        }
      });
      result = { job: null };
    } else if (p.action === "claim") result = { job: await s.claim(d) };
    else if (p.action === "heartbeat")
      result = await s.heartbeat(d, {
        keyReady: p.keyReady,
        priceVersion: p.priceVersion,
      });
    else if (p.action === "finish")
      result = await s.finish(d, p.id, p.leaseToken, p.result);
    else result = await s[p.action](d, p.id, p.leaseToken);
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return failure(e);
  }
}
