import { failure } from "@/server/http";
import { LibraryError } from "@/server/library-store";
// Stage 5 only: no selection mutation is exposed by the Stage 4 release.
export async function POST(){
  return failure(new LibraryError(501,"5단계 이전·검증 및 사용자 승인 후 활성화됩니다."));
}