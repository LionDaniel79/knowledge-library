import { z } from "zod";
import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { validateWriteOrigin } from "@/server/access";
import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
import {
  pdfImportStore,
  importRoot,
  startPdfImportWorker,
  reviewPdfImport,
} from "@/server/pdf-import";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function importOwner() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    requireOwner(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new LibraryError(
              503,
              "로그인 서버 응답이 지연되고 있습니다. 잠시 후 등록을 다시 시도해 주세요.",
            ),
          ),
        15000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
export async function GET(r: Request) {
  try {
    const owner = await importOwner(),
      jobs = pdfImportStore();
    try {
      const params = new URL(r.url).searchParams,
        page = z.coerce
          .number()
          .int()
          .min(1)
          .max(100000)
          .parse(params.get("page") ?? 1);
      return Response.json(
        jobs.summary(
          owner,
          params.has("id")
            ? z.string().uuid().parse(params.get("id"))
            : undefined,
          page,
        ),
        {
          headers: { "Cache-Control": "private, no-store" },
        },
      );
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
    requestId: z.string().uuid().optional(),
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
  let phase = "input";
  const diagnosticId = crypto.randomUUID();
  try {
    validateWriteOrigin(r, process.env.APP_ORIGIN!);
    const p = command.parse(await r.json());
    phase = "authentication";
    const owner = await importOwner();
    phase = "job-store";
    const jobs = pdfImportStore();
    try {
      let id: string;
      if (p.action === "scan") {
        const root = await importRoot(p.root);
        id = jobs.create(owner, root, p.requestId).id;
        phase = "worker-start";
        try {
          startPdfImportWorker(owner, id);
        } catch {
          jobs.startupFailed(id);
          throw new LibraryError(
            503,
            "PDF 등록 작업자를 실행하지 못했습니다. PC 서재 설치를 확인한 뒤 재개해 주세요.",
          );
        }
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
    console.warn("PDF import request failed", {
      diagnosticId,
      phase,
      status: e instanceof LibraryError ? e.status : 500,
    });
    return failure(e);
  }
}
