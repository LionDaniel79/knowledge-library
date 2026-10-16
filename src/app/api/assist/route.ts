import { z } from "zod";
import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { createAssistStore } from "@/server/assist-store";
import { validateWriteOrigin } from "@/server/access";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const store = () => createAssistStore(database);
export async function GET() {
  try {
    return Response.json(await store().status(await requireOwner()), {
      headers,
    });
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
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
            "cancel",
            "adopt",
            "resolveCost",
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
          index: z.number().int().min(0).max(4),
        })
        .strict()
        .parse(p.payload);
      result = await s.adopt(owner, v.id, v.index);
    }
    return Response.json(result, { headers });
  } catch (e) {
    return failure(e);
  }
}
