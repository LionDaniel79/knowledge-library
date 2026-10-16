import { it, expect, vi } from "vitest";
import {
  processAssistStep,
  type AssistJournal,
} from "../src/local/assist/worker";
it("retries result synchronization after response loss without a second provider call", async () => {
  let saved: any = null,
    finishCalls = 0,
    claims = 0;
  const journal: AssistJournal = {
    read: async () => saved,
    write: async (x) => {
      saved = structuredClone(x);
    },
    clear: async () => {
      saved = null;
    },
  };
  const transport: any = {
    heartbeat: async () => {},
    claim: async () =>
      ++claims === 1 ? { id: "request", leaseToken: "lease" } : null,
    begin: async () => ({ task: {}, reservation: {} }),
    renew: async () => {},
    failClaim: async () => {},
    finish: async () => {
      if (++finishCalls === 1) throw Error("lost response");
    },
  };
  const execute = vi.fn(
    async () =>
      ({ status: "settled", valid: true, output: { tags: [] } }) as any,
  );
  await expect(
    processAssistStep({ transport, journal, execute, keyReady: true }),
  ).rejects.toThrow("lost");
  expect(saved.stage).toBe("result");
  await processAssistStep({ transport, journal, execute, keyReady: false });
  expect(saved).toBeNull();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(finishCalls).toBe(2);
});
it("an interrupted send never calls the provider again and a missing key never claims work", async () => {
  let saved: any = {
    stage: "sending",
    job: { id: "request", leaseToken: "lease" },
  };
  const journal: AssistJournal = {
    read: async () => saved,
    write: async (x) => {
      saved = x;
    },
    clear: async () => {
      saved = null;
    },
  };
  const transport: any = {
    heartbeat: vi.fn(),
    claim: vi.fn(),
    finish: vi.fn(),
    failClaim: vi.fn(),
  };
  const execute = vi.fn();
  await processAssistStep({ transport, journal, execute, keyReady: true });
  expect(transport.finish.mock.calls[0][2].status).toBe("unknown");
  expect(execute).not.toHaveBeenCalled();
  await processAssistStep({ transport, journal, execute, keyReady: false });
  expect(transport.claim).not.toHaveBeenCalled();
});
