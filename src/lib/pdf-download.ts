export function pdfDownloadDisposition(path: string) {
  const filename = (path.split(/[\\/]/).at(-1) || "document.pdf").replace(
    /[\r\n]/g,
    "",
  );
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="document.pdf"; filename*=UTF-8''${encoded}`;
}
