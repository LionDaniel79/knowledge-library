import { z } from "zod";
import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { validateWriteOrigin } from "@/server/access";
import { failure } from "@/server/http";
import {
  pdfImportStore,
  importRoot,
  startPdfImportWorker,
  reviewPdfImport,
} from "@/server/pdf-import";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(r: Request) {
  try {
    const owner = await requireOwner(),
      jobs = pdfImportStore();
    try {
      const params = new URL(r.url).searchParams,
        page = z.coerce
          .number()
          .int()
          .min(1)
          .max(100000)
          .parse(params.get("page") ?? 1);
      return Response.json(jobs.summary(owner, undefined, page), {
        headers: { "Cache-Control": "private, no-store" },
      });
    } finally {
      jobs.close();
    }
  } catch (e) {
    return failure(e);
  }
}
const command = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("scan"),
    root: z.string().trim().min(1).max(1000),
  }),
  z.object({
    action: z.enum(["start", "resume", "pause", "retry", "discard"]),
    id: z.string().uuid(),
  }),
  z.object({
    action: z.enum(["apply", "ignore"]),
    id: z.string().uuid(),
    item: z.string().uuid(),
    index: z.number().int().min(0).max(9).default(0),
  }),
]);
export async function POST(r: Request) {
  try {
    validateWriteOrigin(r, process.env.APP_ORIGIN!);
    const owner = await requireOwner(),
      p = command.parse(await r.json()),
      jobs = pdfImportStore();
    try {
      let id: string;
      if (p.action === "scan") {
        const root = await importRoot(p.root);
        id = jobs.create(owner, root).id;
        startPdfImportWorker(owner, id);
      } else {
        id = p.id;
        jobs.required(owner, id);
        if (p.action === "pause") jobs.pause(owner, id);
        else if (p.action === "discard") jobs.discard(owner, id);
        else if (p.action === "apply")
          await reviewPdfImport(database, jobs, owner, id, p.item, p.index);
        else if (p.action === "ignore")
          jobs.patchItem(id, p.item, { reviewed: true });
        else {
          if (p.action === "retry") jobs.retry(owner, id);
          else jobs.start(owner, id);
          startPdfImportWorker(owner, id);
        }
      }
      return Response.json(jobs.summary(owner, id), {
        status: 202,
        headers: { "Cache-Control": "private, no-store" },
      });
    } finally {
      jobs.close();
    }
  } catch (e) {
    return failure(e);
  }
}
