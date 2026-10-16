import { pricingVersion } from "../ai/openai";
import type { AssistTransport } from "./worker";
export function createAssistTransport(
  origin: string,
  token: string,
): AssistTransport {
  const base = new URL(origin);
  if (
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    !(
      base.protocol === "https:" ||
      (base.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))
    )
  )
    throw Error("PC 연결 주소는 HTTPS 또는 이 PC의 주소여야 합니다.");
  if (!/^klw_[A-Za-z0-9_-]{43}$/.test(token))
    throw Error("PC 연결 키 형식을 확인해 주세요.");
  async function post(body: unknown) {
    const r = await fetch(new URL("/api/assist-worker", base), {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) {
      const e = Object.assign(new Error("PC 요청 처리 실패"), {
        status: r.status,
      });
      throw e;
    }
    const text = await r.text();
    if (text.length > 100000) throw Error("작업 응답 크기 초과");
    return JSON.parse(text);
  }
  return {
    heartbeat: (ready) =>
      post({
        action: "heartbeat",
        keyReady: ready,
        priceVersion: pricingVersion,
      }),
    claim: async () => (await post({ action: "claim" })).job,
    begin: (job) => post({ action: "begin", ...job }),
    renew: (job) => post({ action: "renew", ...job }),
    finish: (id, leaseToken, result) =>
      post({ action: "finish", id, leaseToken, result }),
    failClaim: (job) => post({ action: "failClaim", ...job }),
  };
}
