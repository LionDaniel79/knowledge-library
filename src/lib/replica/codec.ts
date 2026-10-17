// Serialized values are retained byte-for-byte. Parsing is for viewing, never
// for computing a new hash of a server value (large integers may lose precision).
export function encodeSyncValue(
  value: Record<string, unknown> | string,
): Uint8Array {
  return new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value),
  );
}
export function decodeSyncValue(bytes: Uint8Array): Record<string, unknown> {
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("자료 형식이 잘못되었습니다.");
  return value as Record<string, unknown>;
}
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
