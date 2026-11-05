import { it, expect } from "vitest";
import { GET as list } from "../src/app/api/pdf/route";
import {
  GET as imports,
  POST as register,
} from "../src/app/api/pdf/import/route";
import {
  GET as reprocess,
  POST as ocr,
} from "../src/app/api/pdf/reprocess/route";
import {
  GET as connection,
  POST as connect,
} from "../src/app/api/pdf/connection/route";
import { POST as cite } from "../src/app/api/pdf/citation/route";
import { GET as file } from "../src/app/api/pdf/[id]/file/route";
import { GET as page } from "../src/app/api/pdf/[id]/page/route";
import { GET as cover } from "../src/app/api/pdf/[id]/cover/route";
import { GET as pcAccess } from "../src/app/api/pc-access/route";
const context = {
  params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
};
const cases: [string, (r: Request) => Promise<Response>][] = [
  ["search", list],
  ["import status", imports],
  ["register", register],
  ["OCR status", reprocess],
  ["OCR", ocr],
  ["connection", () => connection()],
  ["reconnect", connect],
  ["citation", cite],
  ["PC access", pcAccess],
  ["file", (r) => file(r, context)],
  ["page", (r) => page(r, context)],
  ["cover", (r) => cover(r, context)],
];
it.each(cases)(
  "retires %s without starting the PC server or revealing source data",
  async (_label, call) => {
    const response = await call(
      new Request("https://library.invalid/api/pdf?private=not-to-be-returned"),
    );
    expect(response.status).toBe(410);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.code).toBe("desktop_pdf_required");
    expect(JSON.stringify(body)).not.toContain("not-to-be-returned");
  },
);
