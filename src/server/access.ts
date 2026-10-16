import { LibraryError } from "./library-store";
export function authorize(
  user: { id: string; email: string; emailVerified?: boolean } | null,
  owner: string,
): string {
  if (!owner) throw new LibraryError(503, "서재 소유자 설정이 필요합니다.");
  if (!user) throw new LibraryError(401, "로그인이 필요합니다.");
  if (
    user.email.trim().toLowerCase() !== owner.trim().toLowerCase() ||
    !user.emailVerified
  )
    throw new LibraryError(403, "확인된 서재 소유자 계정으로 로그인해 주세요.");
  return user.id;
}
export function validateWriteOrigin(request: Request, origin: string): void {
  if (!origin || request.headers.get("origin") !== new URL(origin).origin)
    throw new LibraryError(403, "이 서재 화면에서 다시 요청해 주세요.");
}
