export function pdfLibraryPath(operations = false) {
  return operations ? "/?view=pdf&panel=operations" : "/?view=pdf";
}
export function libraryEntry(
  query: Record<string, string | string[] | undefined>,
) {
  const pdf = query.view === "pdf",
    operations = pdf && query.panel === "operations";
  return {
    view: pdf ? ("pdf" as const) : ("home" as const),
    operations,
    path: pdf ? pdfLibraryPath(operations) : "/",
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
  return path.startsWith("/connect/mcp?") ||
    path === pdfLibraryPath() ||
    path === pdfLibraryPath(true)
    ? path
    : "/";
}
