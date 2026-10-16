import { existsSync } from "node:fs";
import { requireOwner } from "@/server/auth";
import { failure } from "@/server/http";
import { privatePcOrigin } from "@/lib/pc-access";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await requireOwner();
    return Response.json(
      {
        local: !!(
          process.env.LIBRARY_PDF_INDEX &&
          process.env.LIBRARY_PDF_ROOT &&
          existsSync(process.env.LIBRARY_PDF_INDEX) &&
          existsSync(process.env.LIBRARY_PDF_ROOT)
        ),
        // Serve's private-network mode must also be confirmed by the operator.
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
