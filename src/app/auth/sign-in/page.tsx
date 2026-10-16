import { AuthPanel } from "@/components/auth-panel";
import { configured } from "@/server/auth";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const failed =
    params.login === "failed" || !!params.neon_auth_session_verifier;
  return (
    <AuthPanel
      available={configured()}
      message={
        failed
          ? "로그인을 완료하지 못했습니다. Google 계정으로 다시 연결해 주세요."
          : undefined
      }
    />
  );
}
