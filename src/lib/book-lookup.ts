export interface BookCandidate {
  id: string;
  title: string;
  author: string;
  publisher: string;
  isbn: string;
  coverUrl: string;
  totalPages: number | null;
  provider: "yes24" | "google" | "openlibrary" | "library";
  sourceUrl: string;
  description: string;
  category?: string;
  /** Provider-supplied subjects/keywords; the reader may edit them before saving. */
  tags?: string[];
}
export const catalogProviderNames = {
  yes24: "예스24",
  google: "Google Books",
  openlibrary: "Open Library",
  library: "도서관 정보나루",
};
