import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { readBibliography } from "@/server/bibliography";
import { toRis } from "@/lib/bibliography-exchange";
import { z } from "zod";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const owner = await requireOwner(),
      q = new URL(request.url).searchParams;
    const p = z
      .object({
        bookId: z.string().uuid().optional(),
        researchId: z.string().uuid().optional(),
        format: z.enum(["csl", "ris"]),
      })
      .refine((v) => !!v.bookId !== !!v.researchId)
      .parse({
        bookId: q.get("bookId") ?? undefined,
        researchId: q.get("researchId") ?? undefined,
        format: q.get("format") ?? "csl",
      });
    const data = await readBibliography(database, owner, p);
    return new Response(
      p.format === "ris" ? toRis(data) : JSON.stringify(data, null, 2),
      {
        headers: {
          "Content-Type":
            p.format === "ris"
              ? "application/x-research-info-systems;charset=utf-8"
              : "application/vnd.citationstyles.csl+json;charset=utf-8",
          "Content-Disposition": `attachment; filename="library-bibliography.${p.format === "ris" ? "ris" : "json"}"`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (e) {
    return failure(e);
  }
}
