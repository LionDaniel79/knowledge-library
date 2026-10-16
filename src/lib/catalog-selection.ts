import { z } from "zod";
export const catalogSelection = z
  .object({
    provider: z.enum(["yes24", "google", "openlibrary", "library"]),
    sourceUrl: z.string().max(500),
    description: z.string().max(3000).default(""),
  })
  .refine((v) => {
    try {
      const u = new URL(v.sourceUrl);
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        u.port ||
        u.hash
      )
        return false;
      return v.provider === "yes24"
        ? u.hostname === "www.yes24.com" &&
            /^\/product\/goods\/\d+$/.test(u.pathname) &&
            !u.search
        : v.provider === "google"
          ? u.hostname === "books.google.com" &&
            u.pathname === "/books" &&
            /^\?id=[\w-]+$/.test(u.search)
          : v.provider === "openlibrary"
            ? u.hostname === "openlibrary.org" &&
              /^\/(isbn\/\d{13}|works\/OL\d+W)$/.test(u.pathname) &&
              !u.search
            : u.hostname === "www.data4library.kr" &&
              u.pathname === "/" &&
              !u.search;
    } catch {
      return false;
    }
  }, "서지 출처 주소를 확인해 주세요.");
