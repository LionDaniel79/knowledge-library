// Provider HTML is reduced to text. Decoded markup stays literal text, never HTML.
const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
};
export function providerText(value: unknown): string {
  return decodeEntities(
    String(value ?? "")
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (raw, name: string) => {
    if (!name.startsWith("#")) return entities[name] ?? raw;
    const hex = name[1].toLowerCase() === "x";
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : raw;
  });
}
export function displayProviderText(item: {
  value: string;
  origin: string;
  reviewed_by?: string | null;
  generator?: string;
}): string {
  // Legacy collection already stripped HTML but retained entities. Never strip
  // markup again: a literal <label> may be the result of the first decoding.
  if (
    item.origin !== "provider" ||
    item.reviewed_by ||
    item.generator?.endsWith("/plain-text-v1")
  )
    return item.value;
  return decodeEntities(item.value);
}
