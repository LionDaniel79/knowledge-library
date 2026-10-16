import { z } from "zod";
/** Configuration is a link only; no server proxy, network probing or credential forwarding. */
export function privatePcOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(u.hostname) ||
      u.port ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/"
    )
      return null;
    return u.origin;
  } catch {
    return null;
  }
}
export function pcDocumentUrl(
  origin: string,
  id: string,
  page: number,
  signature?: string,
) {
  const safe = privatePcOrigin(origin);
  if (!safe) throw Error("인증된 PC 주소 설정이 필요합니다.");
  z.string().uuid().parse(id);
  z.number().int().min(1).max(100000).parse(page);
  const u = new URL(`/reader/${id}`, safe);
  u.searchParams.set("page", String(page));
  if (signature)
    u.searchParams.set("signature", z.string().max(500).parse(signature));
  return u.href;
}
