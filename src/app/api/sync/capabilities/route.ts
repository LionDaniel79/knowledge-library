import { requireOwner } from "@/server/auth";
import { database } from "@/server/db";
import { serverAssistConfig } from "@/server/server-assist";
import { failure } from "@/server/http";
import { ASSIST_COMPARISON_ENABLED } from "@/lib/assist";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const owner = await requireOwner();
    const workers = (
      await database.query(
        "SELECT w.key_ready,w.price_version,w.last_seen,d.name FROM library_assist_workers w JOIN library_analysis_devices d ON d.id=w.device_id AND d.owner_id=w.owner_id WHERE w.owner_id=$1 AND d.revoked_at IS NULL AND d.expires_at>now() ORDER BY w.last_seen DESC",
        [owner],
      )
    ).rows;
    return Response.json(
      {
        ownerId: owner,
        execution: serverAssistConfig().ready ? "server" : "pc",
        comparisonEnabled: ASSIST_COMPARISON_ENABLED,
        workers,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
