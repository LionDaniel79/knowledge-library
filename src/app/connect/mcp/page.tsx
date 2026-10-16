import { configured, requireOwner } from "@/server/auth";
import { AuthPanel } from "@/components/auth-panel";
import { McpConsent } from "@/components/mcp-consent";
import { enabledMcp } from "@/server/mcp-endpoints";
import { parseMcpAuthorization } from "@/server/mcp-oauth";
import { LibraryError } from "@/server/library-store";
export const dynamic = "force-dynamic";
export default async function Connect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  let parameters: Record<string, string>, returnPath: string, ownerId: string;
  try {
    const config = enabledMcp(),
      p = await searchParams,
      raw = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) {
      if (Array.isArray(v)) throw Error();
      if (v !== undefined) raw.set(k, v);
    }
    parameters = parseMcpAuthorization(raw, config.origin);
    ownerId = config.ownerId;
    returnPath = "/connect/mcp?" + new URLSearchParams(parameters);
  } catch {
    return (
      <main className="auth-card">
        <h1>연결 요청 확인 필요</h1>
        <p>ChatGPT의 서재 연결 화면에서 다시 시작해 주세요.</p>
      </main>
    );
  }
  try {
    if ((await requireOwner()) !== ownerId)
      throw new LibraryError(403, "서재 주인 계정이 필요합니다.");
  } catch (e) {
    return (
      <AuthPanel
        available={configured()}
        returnPath={returnPath}
        message={
          e instanceof LibraryError && e.status === 401
            ? undefined
            : "서재 주인 Google 계정으로 로그인해 주세요."
        }
      />
    );
  }
  return <McpConsent parameters={parameters} />;
}
