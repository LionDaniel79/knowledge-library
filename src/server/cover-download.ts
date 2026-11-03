import { LibraryError } from "./library-store";
const imageHosts = new Set([
  "image.aladin.co.kr",
  "bookthumb-phinf.pstatic.net",
  "shopping-phinf.pstatic.net",
  "covers.openlibrary.org",
  "image.yes24.com",
  "image.yes24.co.kr",
  "image.yes24.com.ssl.cdn.s.cloudfront.net",
  "books.google.com",
  "books.google.co.kr",
  "books.googleusercontent.com",
  "covers.logoscdn.com",
]);
function imageUrl(source: string) {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new LibraryError(400, "이미지 주소를 확인해 주세요.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !imageHosts.has(url.hostname)
  )
    throw new LibraryError(
      400,
      "이 이미지 주소는 직접 가져올 수 없습니다. 이미지 파일을 올려 주세요.",
    );
  return url;
}
export async function downloadCover(
  source: string,
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  let url = imageUrl(source);
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 15000);
  try {
    for (let i = 0; i < 4; i++) {
      const response = await fetcher(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "image/jpeg,image/png,image/webp,image/gif" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location)
          throw new LibraryError(400, "표지 이미지를 가져올 수 없습니다.");
        url = imageUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new LibraryError(
          response.status === 404 ? 404 : 502,
          "표지 서버에 연결할 수 없습니다.",
        );
      }
      if (
        !/^image\/(jpeg|png|webp|gif)(?:;|$)/i.test(
          response.headers.get("content-type") ?? "",
        )
      ) {
        await response.body?.cancel();
        throw new LibraryError(400, "표지 이미지 형식을 확인할 수 없습니다.");
      }
      const max = 8 * 1024 * 1024;
      if (Number(response.headers.get("content-length")) > max) {
        await response.body?.cancel();
        throw new LibraryError(413, "표지 파일이 너무 큽니다.");
      }
      if (!response.body)
        throw new LibraryError(400, "표지 이미지가 비어 있습니다.");
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > max)
            throw new LibraryError(413, "표지 파일이 너무 큽니다.");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      return Buffer.concat(chunks);
    }
    throw new LibraryError(502, "표지 이미지 주소가 너무 많이 변경되었습니다.");
  } finally {
    clearTimeout(timer);
  }
}
