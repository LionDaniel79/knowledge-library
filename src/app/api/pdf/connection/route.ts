import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { failure } from "@/server/http";
import { validateWriteOrigin } from "@/server/access";
import { privatePcOrigin } from "@/lib/pc-access";
import {
  pdfConnectionState,
  previewPdfConnection,
  applyPdfConnection,
} from "@/server/pdf-reconnect";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const owner = await requireOwner();
    const owned = (
      await database.query(
        "SELECT id FROM library_documents WHERE owner_id=$1 LIMIT 1",
        [owner],
      )
    ).rows.length;
    const state = owned
      ? await pdfConnectionState()
      : { available: false, version: 0, connected: false };
    return Response.json(
      {
        ...state,
        pcOrigin:
          process.env.LIBRARY_PC_PRIVATE_CONFIRMED === "true"
            ? privatePcOrigin(process.env.LIBRARY_PC_ORIGIN)
            : null,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(r: Request) {
  try {
    validateWriteOrigin(r, process.env.APP_ORIGIN!);
    const owner = await requireOwner(),
      p = await r.json();
    return Response.json(
      await (p.action === "apply" ? applyPdfConnection : previewPdfConnection)(
        database,
        owner,
        p,
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
