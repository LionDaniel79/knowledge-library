import { retiredPdf } from "@/server/retired-pdf";
export const dynamic = "force-dynamic";
export async function GET(_request: Request) {
  return retiredPdf();
}
export async function POST(_request: Request) {
  return retiredPdf();
}
