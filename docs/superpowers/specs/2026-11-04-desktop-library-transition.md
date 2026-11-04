# 승인된 지식서재·Windows PDF 전체 개편

승인: 2026-11-04 사용자 직접 지시. 전체를 구현하며 통상적인 선택은 개발자가 결정한다. 이 파일은 이어서 작업할 때의 기준이다.

## 확정 범위
1. 웹 PDF 원문검색 메뉴·OCR·PDF PC 연결 의존 제거.
2. Windows WPF/Python 독립 PDF 등록·검색·OCR·색인. 상시 HTTP 서버 없이 동작.
3. 대체 기능 검증 후 기존 PC PDF 서버/자동실행/예약 작업을 안전하게 철거. Vercel/Neon 웹앱은 유지.
4. 필요한 PDF 서지검색은 유지. 불필요한 PDF 서지는 실제 DB에서 제거. 메모·독서 이력·출처는 먼저 보존하며 실제 삭제는 확정 대상·최신 백업·구체적 검토 결과 뒤 최종 승인 지점으로 둔다.
5. 웹 PDF 등록 범위는 전자도서관의 기독도서/일반도서 및 하위 폴더뿐. 기존 직접 삭제·제외 결정을 자동 복원하지 않는다.
6. Windows 관리 범위는 전자도서관 전체: 논문/간행물 포함. 미OCR 자료까지 인식·색인을 보완.
7. Logos 2,418개 텍스트 자료 등록·중복 검토·서지/표지 보완. ISBN 없는 자료는 제목/저자/출판사 후보→판본 확인. 불일치·정보 없는 원서는 기존 Logos 정보 보존. 표지는 외부 링크 의존 없이 실제 이미지 저장.
8. 최초 전체/이후 추가 PDF 일괄 웹 등록. 신규 파일 감지와 백그라운드 OCR, 대기열·오류·진행 파일/쪽수·일시정지·재시도·재시작 이어하기. 닫기는 트레이, 명시적 종료는 안전 중단.
9. 위치 일괄 확인: PC 실경로, 웹 보관함 키+상대경로, 마지막 확인 시각. 이동/이름 변경은 내용 지문으로 동일성 확인하여 갱신. 여러 사본 유지, ID와 메모 관계 보존. 외장 분리를 누락/삭제로 처리하지 않는다.
10. Windows→웹은 outbound HTTPS만 사용. PDF/OCR 본문·로컬 파일 해시는 서버에 보내지 않는다. 파일 경로는 웹 등록 대상의 승인된 상대경로만 전송. 중단/오프라인 큐·변경분만·중복 재시도 보호.

## 구현 순서·소유 파일
A. desktop/pdf-library: 독립 관리 SQLite + 기존 색인 읽기 재사용, 스캔·안전한 경로·중복/이동, 신규 파일 ID/작업 큐/FTS·OCR, WPF 트레이와 진행 상태, batch HTTPS/위치 점검, 설치/시작 바로가기. 원본 SQLite는 읽기만 하고 새 관리 DB에 결과를 쌓는다.
B. src/lib/desktop-library-contract.ts, src/server/desktop-library.ts, src/app/api/desktop/library/route.ts: 기기 인증을 재사용하는 신규 등록/위치 갱신 API. 기존 v2 manifest는 그대로 보존.
C. Logos·catalog 보완: 기존 수집기 재사용, 제목 후보 검토와 ISBN 근거, 이미지 영구 저장, 중단 재개 일괄 작업. 라이브 생성은 승인된 대상 검토 뒤.
D. 웹 legacy PDF 메뉴/열기 UI/PC 설정·원문 API 제거, 서지-only 위치 표시. PDF 자료 삭제의 구체적 preview/checksum/참조 보존·sync tombstones·blocked reimport 설계와 격리 시험.
E. 설치/운영 적용: 테스트·독립 검토→최신 백업 검증→QA→실제 원본/관계 보존 확인→운영/PC 적용, 필요한 삭제 승인만 마지막에 질문.

## 신규 desktop library API 계약 (기존 manifest v2와 별도)
POST /api/desktop/library, HTTPS+기존 catalog:write 기기 인증/owner. 본문은 {requestId:UUID, action:'upsert', items:[최대100]}.
각 항목: {resourceId:UUID, legacyDocumentId?:UUID, bookId?:UUID, expectedBookVersion?:정수, metadata:{title,author?,publisher?,isbn?,totalPages?}, locations:[{rootKey:'christian'|'general',relativePath:문자열}]}.
resourceId는 PC의 content 식별 UUID(파일 hash 원문 아님). legacyDocumentId/bookId가 있으면 소유자·버전·기존 제외 상태 검사. 없으면 서버가 신규 도서/문서 ID 발급. 같은 owner/device/resource의 재시도는 기존 ID 반환. 서로 다른 자료를 제목/ISBN만으로 자동 병합하지 않는다.
응답 {requestId,items:[{resourceId,bookId,documentId,bookVersion,state:'registered'|'unchanged'|'excluded'|'conflict'}]}. 결과에 개인 파일 경로·키를 로그로 출력하지 않는다.
위치는 library_books.enrichment.desktopPdf 에 보관해 기존 증분 동기화 재사용(새 replica entity 불필요). {resourceId,deviceId,locations,lastCheckedAt} 형태이며 수동 서지/기존 source_data는 보존. 새 API의 저장 모델은 구현 시 기존 문서/출처 스키마를 확인하여 정한다.
문자열 크기/개수/경로이탈/드라이브·UNC·제어문자·잘못된 UUID는 거절. 목록 전체 검증 후 한 트랜잭션; requestId fingerprint 불일치 거절. 기기 해제/만료/교차 owner 거절.

## 검수·보존
기존 base c09137b: 단위805+조건부4, Playwright332, desktop/API Python24, PDF/OCR42, WPF build/search/page/cancel PASS. GitHub 원격은 한도 소진으로 실행 전 차단, 자동 반복 금지.
원본 PDF 이동/수정/삭제 금지. 기존 운영 SQLite/OCR와 메모/독서 이력/미전송 기기 데이터 보존. 실제 자료 삭제/새 인증/유료 계약 같은 되돌릴 수 없는 단계는 구체적 결과 뒤 사용자 확인; 일상적인 구현·격리 시험·검토 PR은 자율 진행.
새 관리/시험 데이터는 원본과 분리. 운영 데이터와 비밀을 테스트 fixture나 GitHub에 복사하지 않는다. 실제 서버 철거는 아직 하지 않는다.

