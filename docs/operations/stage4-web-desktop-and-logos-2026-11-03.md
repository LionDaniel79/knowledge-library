# 지식서재 4단계: 웹앱 로고스 등록·표지, 지정 PDF 동기화, 기존 PDF 보관·재등록

> 개발 단계는 기능 구현과 테스트를 포함한다. 운영 Neon에 실제 1,511건을 등록하거나 PDF를 자동 보관·삭제하지 않는다.

## 1. 확정 범위 및 실자료 검산

- 로고스 XML: `서재.xml` 2,620건. `Resource Type`의 **정확한 값** `성경 주석` 967건, `단행본` 544건만 등록 대상이다. 합계 **1,511건**(영구 소유 1,470, 임시 소유 41); 다른 종류 1,109건은 제외한다. `주석`, `설교`, `성경`, `조직 신학` 등은 유사한 제목이어도 자동 포함하지 않는다.
- 로고스 XML에는 ISBN과 표지 이미지가 없다. 기존 제목·저자 충돌은 자동 병합하지 않고 검토 목록에 보존한다. 두 자료 유형은 클라이언트 필터뿐 아니라 서버 스키마에서도 강제한다.
- 기존 Windows PDF 검색 대상: E:\\전자도서관 전체 9,319개. 웹 등록·동기화 선택 루트: `기독도서` 3,598개, `일반도서` 511개(하위 폴더 포함), 합계 4,109개 물리 파일, 4,108개 고유 기존 문서 ID. 새 파일/제외 파일/소실 파일을 자동으로 병합·제거하지 않는다.
- 원본 PDF·OCR·SQLite·기존 도서 ID·메모·독서 기록을 보존한다.

## 2. 웹앱 로고스 도서·표지 등록

- `/logos/import`: 브라우저에서 Excel 2003 XML 파싱, DTD 차단, 등록 대상만 표시하고 제외 1,109건을 따로 표시. 100건씩 서버 기존 Neon 도서·판본 충돌 미리보기.
- `POST /api/logos`: `preview`와 `apply` 계약. `apply`는 소유자 인증·쓰기 출처 검사·서버 유형 allowlist·기존 동일 판본 보호·안정 Resource ID를 사용한다. `LIBRARY_STAGE5_WRITE_ENABLED=true` 없이는 실제 INSERT를 403으로 거부한다. 화면의 등록 버튼 역시 이 권한이 열린 경우에만 보이며 별도 확인을 요구한다.
- `/logos/covers`: 사용자가 확인한 도서 표지 HTTPS 이미지 URL을 판본 검토 후 연결한다. 원래 저장된 표지를 무단 덮어쓰지 않는다. 공식 Logos CDN을 포함한 허용 호스트, 크기·형식 검사, 소유자별 읽기 보호를 적용한다.
- 외부 URL 프록시를 영구 오브젝트 저장으로 오해하지 않는다. 외부 호스트가 이미지를 지우면 재현할 수 없으므로 대규모 영구 표지 저장이 필요한 경우 별도 오브젝트 저장소 검증이 필요하다.

## 3. 지정 PDF 폴더 동기화 API v2

- `/desktop/connect`: 30일 만료 소유자 기기 토큰 발급·폐기, SHA-256 해시만 DB에 저장. 실제 Windows 프로그램은 DPAPI 등 보호된 저장소를 사용한다.
- `POST /api/desktop/catalog/manifests`: `{operationId,scanComplete:true,rootsAvailable:true,physicalByRoot:{christian,general},expectedDocuments}`를 받는다.
- `PUT /api/desktop/catalog/manifests/:id/items`: 최대 200건씩 `{legacyDocumentId,bookId,expectedBookVersion,copiesByRoot:{christian,general}}`를 받는다.
- `POST /api/desktop/catalog/manifests/:id/seal`: 물리 파일 수와 sorted canonical JSON UTF-8 SHA-256 `itemsDigest`를 검산한다. `/preview`와 `/desktop/review`는 충돌·누락 및 보관 후보를 읽기 전용으로 보여 준다.
- 미완료 스캔, ID 소유자 불일치, 파일 개수/지문 불일치, 버전 충돌은 거부한다. 원본 파일·OCR 내용·절대 경로는 서버에 전송하지 않는다.
- Windows 3단계 클라이언트는 현재 mock outbox 방식이다. 실제 Windows HTTPS 전송 통합시험은 로컬 소스·인증키가 준비되어야 한다.

## 4. 기존 PDF의 보관·재등록

- 원본 `library_books`, `library_documents`, OCR·PDF 파일·메모·읽기 이력은 **삭제하지 않는다**.
- `library_book_exclusions.kind='pdf_archive'`는 기존 PDF 도서를 논리적 보관 상태로 표시하고 `library_pdf_registry.state`는 `registered`/`archived` 상태를 구분한다. 이미 수동으로 삭제·제외된 다른 종류는 덮어쓰지 않는다.
- 확정된 manifest의 선택 문서를 동일 `document_id`/`book_id`로 재등록하고, 이전에 보관된 도서는 `restored` 상태로 복원한다. 선택되지 않은 기존 PDF만 논리적으로 보관한다. 버전 충돌·소유자 충돌·보관 후보 수 불일치면 전체 작업을 거부한다.
- `POST /api/desktop/catalog/manifests/:id/apply-selection`은 서버 승인용 플래그와 정확한 `itemsDigest`·보관 후보 수·확인 문구를 모두 요구한다. 4단계 기본 상태에서 HTTP 403이므로 대량 데이터가 실수로 변경되지 않는다.
- 최종 영구 삭제를 위한 `/api/desktop/catalog/cleanup/apply-batch`는 계속 HTTP 501로 잠근다. 보관은 삭제가 아니다.
- 기존 PDF를 재등록해도 OCR 재생성이나 사용자 노트의 새로운 도서로의 자동 이전을 하지 않는다.

## 5. 검증과 운영 경계

- `db/035_desktop_catalog_and_logos.sql`은 기존 스키마를 보존하면서 기기·로고스·PDF 등록·보관 상태를 추가한다. `scripts/migrate.ts`는 테스트 DB에서 먼저 적용·복원 시험한다.
- 코드에는 XML 타입 제한, 기기 인증·소유자 경계, manifest 수량/지문 검산, 보관·재등록 기본 차단 및 왕복 회귀 테스트가 포함된다.
- 4단계 PR 초안 상태를 유지하며 실제 운영 Neon 마이그레이션·자료 등록·PDF 보관·삭제·main 병합·Vercel 배포는 자동 진행하지 않는다.
- 실기기 HTTPS 및 운영 데이터 검증, 외부 백업 복원, 표지 영구 저장 전략, 오래된 참조와 모바일 재접속 검사는 배포 승인 전에 별도로 완료해야 한다.
