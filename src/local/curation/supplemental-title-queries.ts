/** Discovery hints only. None of these establish an ISBN or edition match. */
export function supplementalTitleQueries(title: string) {
  const base = title
    .normalize("NFKC")
    .replace(/\.pdf$/i, "")
    .trim();
  if (base.length > 200) return [];
  const cleaned = base.replace(/^\d{1,3}\.\s*\[[^\]]{1,20}\]\s*/, "");
  const parts = cleaned.split(/\s*[-–—]\s*/);
  const valid = (s: string) => s.length >= 2 && /[\p{L}]{2}/u.test(s);
  if (parts.length === 2 && parts.every(valid)) {
    return [
      { title: parts[0], author: parts[1] },
      { title: parts[1], author: parts[0] },
      { title: parts[0], author: "" },
      { title: parts[1], author: "" },
    ];
  }
  return cleaned !== base && valid(cleaned)
    ? [{ title: cleaned, author: "" }]
    : [];
}
