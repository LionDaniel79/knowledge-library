import { z } from "zod";
import { requireOwner } from "@/server/auth";
import { validateWriteOrigin } from "@/server/access";
import { failure } from "@/server/http";
import { ocrControl, startOcrWorker } from "@/server/reocr";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(r: Request) {
  try {
    const owner = await requireOwner(),
      p = new URL(r.url).searchParams,
      id = p.has("id") ? z.string().uuid().parse(p.get("id")) : undefined,
      page = z.coerce
        .number()
        .int()
        .min(1)
        .max(1000000)
        .parse(p.get("page") ?? 1);
    return Response.json(
      await ocrControl(owner, { action: "status", id, page }),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
const command = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    scope: z.enum(["all", "unfinished"]).default("all"),
    sample: z.boolean().default(true),
  }),
  z.object({
    action: z.enum([
      "pause",
      "resume",
      "retry",
      "discard",
      "apply_all",
      "restore_all",
    ]),
    id: z.string().uuid(),
  }),
  z.object({
    action: z.enum(["apply", "restore", "exclude"]),
    id: z.string().uuid(),
    pageId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    includeReview: z.boolean().default(false),
  }),
]);
export async function POST(r: Request) {
  try {
    validateWriteOrigin(r, process.env.APP_ORIGIN!);
    const owner = await requireOwner(),
      p = command.parse(await r.json());
    const result = await ocrControl(owner, p),
      job = result.job;
    if (
      job &&
      ["create", "resume", "retry", "apply_all", "restore_all"].includes(
        p.action,
      )
    ) {
      const action =
        p.action === "apply_all"
          ? "apply"
          : p.action === "restore_all"
            ? "restore"
            : p.action === "resume" && job.mode === "applying"
              ? "apply"
              : p.action === "resume" && job.mode === "restoring"
                ? "restore"
                : "work";
      startOcrWorker(owner, job.id, action);
    }
    return Response.json(result, {
      status: 202,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return failure(e);
  }
}
