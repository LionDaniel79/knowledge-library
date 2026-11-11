export function libraryEntry(
  query: Record<string, string | string[] | undefined>,
) {
  return {
    view: query.view === "pdf" ? ("books" as const) : ("home" as const),
    path: "/",
  };
}

export function authReturnPath(path: string) {
  return path.startsWith("/connect/mcp?") ? path : "/";
}
