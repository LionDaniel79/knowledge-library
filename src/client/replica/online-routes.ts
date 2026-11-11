// Live capabilities, credentials and external PC/provider operations are never
// mistaken for stored application data. New GET routes require an explicit decision.
export function onlineOnlyGet(path: string) {
  return (
    [
      "/api/book-lookup",
      "/api/bibliography",
      "/api/backup",
      "/api/export",
      "/api/mcp-connections",
    ].includes(path) ||
    /^\/api\/(auth|mcp|sync)(\/|$)/.test(path) ||
    /^\/api\/(book-covers|import-assets)\//.test(path)
  );
}
