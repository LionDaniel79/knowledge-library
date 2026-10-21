export function pdfLibraryPath(operations = false) {
  return operations ? "/?view=pdf&panel=operations" : "/?view=pdf";
}
const pdfId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function pdfSearchPath(q: string, id?: string) {
  if (q.length > 200 || (id && !pdfId.test(id)))
    throw Error("PDF 검색 조건을 확인해 주세요.");
  const params = new URLSearchParams({
    view: "pdf",
    pdfMode: "search",
    pdfQuery: q,
  });
  if (id) params.set("pdfId", id);
  return "/?" + params;
}
export function readPdfSearchEntry(search: string) {
  const p = new URLSearchParams(search),
    q = p.get("pdfQuery") ?? "",
    id = p.get("pdfId") ?? undefined;
  if (
    p.get("pdfMode") !== "search" ||
    q.length > 200 ||
    (id && !pdfId.test(id))
  )
    return null;
  return { q, id };
}
export function libraryEntry(
  query: Record<string, string | string[] | undefined>,
) {
  const pdf = query.view === "pdf",
    operations = pdf && query.panel === "operations";
  return {
    view: pdf ? ("pdf" as const) : ("home" as const),
    operations,
    path: pdf
      ? query.pdfMode === "search" &&
        typeof query.pdfQuery === "string" &&
        query.pdfQuery.length <= 200 &&
        (!query.pdfId ||
          (typeof query.pdfId === "string" && pdfId.test(query.pdfId)))
        ? pdfSearchPath(query.pdfQuery, query.pdfId as string | undefined)
        : query.panel === "folder"
          ? "/?view=pdf&panel=folder"
          : pdfLibraryPath(operations)
      : "/",
  };
}
export function authReturnPath(path: string) {
  if (/^\/reader\/[0-9a-f-]{36}(?:\?|$)/i.test(path)) {
    const u = new URL(path, "https://local.invalid");
    const page = u.searchParams.get("page");
    if (
      !u.hash &&
      !/[\\\r\n]/.test(path) &&
      /^\/reader\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        u.pathname,
      ) &&
      [...u.searchParams.keys()].every(
        (k) =>
          ["page", "signature"].includes(k) &&
          u.searchParams.getAll(k).length === 1,
      ) &&
      (page === null || (/^[1-9]\d*$/.test(page) && Number(page) <= 100000)) &&
      (u.searchParams.get("signature")?.length ?? 0) <= 500
    )
      return u.pathname + u.search;
    return "/";
  }
  if (path.startsWith("/?view=pdf")) {
    const u = new URL(path, "https://local.invalid");
    const allowed = ["view", "panel", "pdfMode", "pdfQuery", "pdfId"];
    if (
      !u.hash &&
      !/[\\\r\n]/.test(path) &&
      [...u.searchParams.keys()].every(
        (k) => allowed.includes(k) && u.searchParams.getAll(k).length === 1,
      )
    ) {
      const entry = libraryEntry(Object.fromEntries(u.searchParams));
      if (entry.path === u.pathname + "?" + u.searchParams.toString())
        return entry.path;
    }
    return "/";
  }
  return path.startsWith("/connect/mcp?") ||
    path === pdfLibraryPath() ||
    path === pdfLibraryPath(true)
    ? path
    : "/";
}
