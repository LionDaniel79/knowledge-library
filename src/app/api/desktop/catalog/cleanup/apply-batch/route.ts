import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
// Stage 5 only: a manifest is never authorization to delete cloud records.
export async function POST(){
  return failure(new LibraryError(501,"5단계 백업 복구 검증과 별도 삭제 승인 전에는 사용할 수 없습니다."));
}