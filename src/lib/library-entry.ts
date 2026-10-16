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
  return path.startsWith("/connect/mcp?") ||
    path === pdfLibraryPath() ||
    path === pdfLibraryPath(true)
    ? path
    : "/";
}
