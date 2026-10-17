import { createNeonAuth } from "@neondatabase/auth/next/server";
import { LibraryError } from "./library-store";
import { authorize } from "./access";
let instance: ReturnType<typeof createNeonAuth> | undefined;
export function configured() {
  return !!(
    process.env.DATABASE_URL &&
    process.env.NEON_AUTH_BASE_URL &&
    process.env.NEON_AUTH_COOKIE_SECRET &&
    process.env.LIBRARY_OWNER_EMAIL
  );
}
export function getAuth() {
  if (!process.env.NEON_AUTH_BASE_URL || !process.env.NEON_AUTH_COOKIE_SECRET)
    throw new LibraryError(503, "온라인 서재 연결 설정이 필요합니다.");
  return (instance ??= createNeonAuth({
    baseUrl: process.env.NEON_AUTH_BASE_URL,
    cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET },
  }));
}
export async function requireOwner() {
  if (!configured())
    throw new LibraryError(503, "온라인 서재 연결 설정이 필요합니다.");
  const { data: session, error } = await getAuth().getSession();
  if (error && error.status !== 401 && error.status !== 403) {
    console.warn("Library authentication temporarily unavailable", {
      status: error.status,
    });
    throw new LibraryError(
      error.status === 429 ? 429 : 503,
      "로그인 서버 연결이 일시적으로 지연되고 있습니다. 잠시 후 동기화를 재개해 주세요.",
    );
  }
  return authorize(session?.user ?? null, process.env.LIBRARY_OWNER_EMAIL!);
}
