import type { WorkerTransport } from "../../lib/thought-map/jobs";
import { collectSourcePages } from "../../lib/thought-map/jobs";
import type { AnalysisProvenance } from "../../lib/thought-map/types";
export function createRemoteTransport(
  config: { origin: string; token: string; provenance?: AnalysisProvenance },
  fetchImpl: typeof fetch = fetch,
): WorkerTransport {
  const url = new URL(config.origin);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname)
      ))
  )
    throw Error("PC 연결 주소는 HTTPS 또는 로컬 주소여야 합니다.");
  async function call(op: string, payload: unknown = {}) {
    const body = JSON.stringify({ op, ...(payload as object) });
    if (Buffer.byteLength(body) > 512 * 1024)
      throw Error("worker_payload_too_large");
    const r = await fetchImpl(url.origin + "/api/thought-worker", {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + config.token,
      },
      body,
      signal: AbortSignal.timeout(30000),
    });
    if (r.redirected) throw Error("worker_redirect");
    const text = await r.text();
    if (Buffer.byteLength(text) > 512 * 1024)
      throw Error("worker_response_too_large");
    const data = JSON.parse(text);
    if (!r.ok) throw Error(`worker_request_${r.status}`);
    return data;
  }
  const lease = (j: Parameters<WorkerTransport["renew"]>[0]) => ({
    id: j.id,
    leaseToken: j.leaseToken,
  });
  return {
    claim: async () =>
      (await call("claim", { provenance: config.provenance })).job,
    renew: async (j) => (await call("renew", lease(j))).renewed,
    getSources: (j) =>
      collectSourcePages((page) => call("sources", { ...lease(j), ...page })),
    finish: async (j, result) => {
      await call("finish", { ...lease(j), result });
    },
    fail: async (j, code) => {
      await call("fail", { ...lease(j), code });
    },
    heartbeat: async (nextPollSeconds) => {
      await call("heartbeat", {
        nextPollSeconds,
        provenance: config.provenance,
      });
    },
  };
}
