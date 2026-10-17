// Live capabilities, credentials and external PC/provider operations are never
// mistaken for stored application data. New GET routes require an explicit decision.
export function onlineOnlyGet(path: string) {
  return (
    [
      "/api/library-operations",
      "/api/book-lookup",
      "/api/bibliography",
      "/api/pc-access",
      "/api/backup",
      "/api/export",
      "/api/mcp-connections",
    ].includes(path) ||
    /^\/api\/(pdf|auth|mcp|sync)(\/|$)/.test(path) ||
    /^\/api\/(book-covers|import-assets)\//.test(path)
  );
}
