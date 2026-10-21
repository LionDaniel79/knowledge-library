import { vi, it, expect } from "vitest";
vi.mock("@/server/auth", () => ({ requireOwner: async () => "owner" }));
vi.mock("@/server/reocr", () => ({
  ocrControl: vi.fn(async () => ({
    job: {
      id: "11111111-1111-4111-8111-111111111111",
      state: "queued",
      mode: "running",
    },
  })),
  startOcrWorker: vi.fn(),
}));
import { POST } from "../src/app/api/pdf/reprocess/route";
import { startOcrWorker, ocrControl } from "../src/server/reocr";
it("validates origin and commands before starting a local-only worker", async () => {
  const old = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = "http://localhost:3000";
  const req = (body: any, origin = "http://localhost:3000") =>
    new Request("http://localhost:3000/api/pdf/reprocess", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    expect(
      (
        await POST(
          req(
            { action: "create", sample: true, scope: "all" },
            "https://elsewhere.test",
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (await POST(req({ action: "create", sample: true, scope: "all" })))
        .status,
    ).toBe(202);
    expect(startOcrWorker).toHaveBeenCalledWith(
      "owner",
      "11111111-1111-4111-8111-111111111111",
      "work",
    );
    expect(
      (await POST(req({ action: "apply", id: "bad", pageId: 1 }))).status,
    ).toBe(400);
    expect(
      (
        await POST(
          req({
            action: "apply",
            id: "11111111-1111-4111-8111-111111111111",
            pageId: 1,
            includeReview: true,
          }),
        )
      ).status,
    ).toBe(202);
    expect(ocrControl).toHaveBeenCalledWith(
      "owner",
      expect.objectContaining({ pageId: 1, includeReview: true }),
    );
  } finally {
    if (old === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = old;
  }
});
