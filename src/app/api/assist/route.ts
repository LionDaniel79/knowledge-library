import { measureAssistDatabase } from "@/server/assist-timing";
import { z } from "zod";
import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { createAssistStore } from "@/server/assist-store";
import { validateWriteOrigin } from "@/server/access";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
import { after } from "next/server";
import {
  processServerAssist,
  serverAssistConfig,
} from "@/server/server-assist";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Cache-Control": "private, no-store" };
const store = () => createAssistStore(database);
export async function GET(request: Request) {
  try {
    const owner = await requireOwner(),
      id = new URL(request.url).searchParams.get("id"),
      state = await store().status(owner, {
        compact: !id,
        ...(id ? { id: z.string().uuid().parse(id) } : {}),
      }),
      server = serverAssistConfig().ready;
    if (
      server &&
      state.requests.some((r: any) =>
        ["queued", "claimed", "sending"].includes(r.status),
      )
    )
      schedule(owner);
    return Response.json(
      { ...state, execution: server ? "server" : "pc" },
      {
        headers,
      },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  const handlerAt = performance.now();
  let timingHeader = "";
  try {
    validateWriteOrigin(request, process.env.APP_ORIGIN ?? "");
    const owner = await requireOwner(),
      text = await request.text();
    if (Buffer.byteLength(text) > 30000)
      throw new LibraryError(413, "요청이 너무 큽니다.");
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new LibraryError(400, "요청 내용을 확인해 주세요.");
    }
    const p = z
        .object({
          action: z.enum([
            "preview",
            "request",
            "configure",
            "allowRequest",
            "cancel",
            "adopt",
            "resolveCost",
            "hide",
          ]),
          payload: z.unknown(),
        })
        .strict()
        .parse(body),
      s = store();
    let result;
    if (p.action === "preview") result = await s.preview(owner, p.payload);
    else if (p.action === "request") result = await s.request(owner, p.payload);
    else if (p.action === "configure")
      result = await s.configure(owner, p.payload);
    else if (p.action === "allowRequest")
      result = await s.allowRequest(owner, p.payload);
    else if (p.action === "hide")
      result = await s.hide(
        owner,
        z.object({ id: z.string().uuid() }).strict().parse(p.payload).id,
      );
    else if (p.action === "cancel")
      result = await s.cancel(
        owner,
        z.object({ id: z.string().uuid() }).strict().parse(p.payload).id,
      );
    else if (p.action === "resolveCost") {
      const v = z
        .object({ id: z.string().uuid(), costUsd: z.string() })
        .strict()
        .parse(p.payload);
      result = await s.resolveCost(owner, v.id, v.costUsd);
    } else {
      const v = z
        .object({
          id: z.string().uuid(),
          index: z.number().int().min(0).max(7),
        })
        .strict()
        .parse(p.payload);
      const timing = measureAssistDatabase(database),
        adoptAt = performance.now();
      result = await createAssistStore(timing.db).adopt(owner, v.id, v.index);
      timingHeader = `adopt;dur=${(performance.now() - adoptAt).toFixed(1)}, ${timing.header()}`;
    }
    if (p.action === "request" && serverAssistConfig().ready) schedule(owner);
    return Response.json(result, {
      headers: {
        ...headers,
        ...(timingHeader
          ? {
              "Server-Timing": `handler;dur=${(performance.now() - handlerAt).toFixed(1)}, ${timingHeader}`,
            }
          : {}),
      },
    });
  } catch (e) {
    return failure(e);
  }
}
function schedule(owner: string) {
  after(async () => {
    try {
      await processServerAssist(database, owner);
    } catch {
      console.warn(
        "AI 결과 저장·연결 확인이 필요합니다. 같은 요청을 자동 재전송하지 않습니다.",
      );
    }
  });
}
