import { retiredPdf } from "@/server/retired-pdf";
export const dynamic = "force-dynamic";
export async function GET(
  _request: Request,
  _context: { params: Promise<{ id: string }> },
) {
  return retiredPdf();
}
