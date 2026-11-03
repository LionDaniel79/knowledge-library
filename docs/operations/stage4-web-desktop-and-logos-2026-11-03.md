# 4단계 웹앱 통합: 연동 규격과 안전한 배포

> 이 단계는 코드와 검증을 준비한다. 운영 PDF/SQLite/Neon 데이터는 수정·삭제하지 않는다.

## 1. 고정된 범위

Windows 로컬 검색: E:\전자도서관 전체 PDF 9,319개.

웹 PDF 등록 범위: E:\전자도서관\기독도서 및 E:\전자도서관\일반도서, **각각 하위 폴더 포함**. 선택 4,109개 물리 파일, 4,108개 고유 기존 문서 ID. 추가 사본 1개는 새 도서가 아니다. 기존 9,321 중 삭제 후보 5,213개는 5단계 별도 승인 전 제거 금지.

## 2. DB와 배포

- db/035_desktop_catalog_and_logos.sql: 등록 manifest, 기기 토큰, Logos 출처, 선택 PDF registry, 표지 참조 테이블만 생성. 기존 PDF 도서·문서·메모·동기화 기록은 그대로 둔다.
- scripts/migrate.ts에서 새 마이그레이션을 호출한다. 승인된 테스트 DB에서 먼저 복원/시험한 뒤 운영 DB에 적용한다.
- 이번 PR은 기본 브랜치 병합/운영 배포를 하지 않는다. 마이그레이션과 배포를 별도 검수한다.
- 5단계 이전 apply-selection 및 cleanup/apply-batch는 HTTP 501, Logos apply는 환경변수 LIBRARY_STAGE5_WRITE_ENABLED=true 없이는 403.

## 3. Windows HTTPS API v2

로그인한 서재 소유자가 /desktop/connect에서 30일 제한된 기기 키를 발급하고 철회한다. DB에는 키의 SHA-256만 저장한다. Windows에는 DPAPI 등을 이용해 비밀을 보호한다.

- POST /api/desktop/catalog/manifests: JSON {operationId,scanComplete:true,rootsAvailable:true,physicalByRoot:{christian,general},expectedDocuments}
- PUT /api/desktop/catalog/manifests/:id/items: JSON {items:[{legacyDocumentId,bookId,expectedBookVersion,copiesByRoot:{christian,general}}]}, 최대 200개.
- POST /api/desktop/catalog/manifests/:id/seal: JSON {itemsDigest}.
- POST /api/desktop/catalog/manifests/:id/preview: 조회 전용; 버전 충돌/등록 상태/삭제 후보 개수.
- POST /api/desktop/catalog/cleanup/preview: JSON {manifestId}. 참조 건수만 조회.

itemsDigest는 UUID 오름차순으로 정렬한 각 행의 [legacyDocumentId_lowercase,bookId_lowercase,expectedBookVersion,christianCopies,generalCopies] 배열들의 JSON을 공백 없이 직렬화한 다음 UTF-8 SHA-256 hex를 계산한다. Python: json.dumps(data,ensure_ascii=False,separators=(',',':')). 3단계 모의 전송기는 physicalByRoot 및 copiesById 값을 위 규격으로 변환하고 실제 HTTP 호출/기기 인증을 5단계에서 검증해야 한다.

루트 연결 실패, 스캔 미완료, 수량 불일치, 알 수 없는 PDF ID, 소유권 오류, 다른 본문의 작업 ID 재사용은 거부한다. 원본 PDF, OCR 본문, 파일 SHA, 절대/상대 디스크 경로는 서버에 보낼 수 없다.

## 4. Logos

/logos/import 페이지에서 Excel 2003 XML을 브라우저 파싱한다. DTD/ENTITY는 차단한다. Resource ID로 중복 방지, License 영구/임시 구분, 최대 100건씩 서버 미리보기. 중복 도서 판본은 자동 병합하지 않는다. ISBN/표지는 XML에 없으므로 추측해서 저장하지 않는다. 실제 추가는 5단계 게이트를 명시적으로 열 때만 허용한다.

## 5. 표지

POST /api/logos/covers는 사용자가 판본을 확인한 Logos 도서에 한하여 외부 HTTPS 표지 URL을 연결한다. 출처/확인 상태는 library_cover_locations에 둔다. 사용자 기존 표지는 자동 덮어쓰지 않는다. 이미 검증된 외부 이미지는 최적화한 WebP 프록시를 통해 표시하므로 기존 Neon base64 표지 저장소의 5,000 슬롯을 추가로 소비하지 않는다. 이미지 출처 도메인 검증·다운로드 크기 제한을 적용한다.

전체 Logos 2,620종에 대한 이미지 자동 확보/확정과 선택 PDF의 기존 로컬 표지 이전은 아직 수행하지 않았다. 대량 Neon Storage 오브젝트 업로드도 활성화하지 않았다. 해당 작업은 실제 서지 등록 및 양쪽 프로그램 검증 때 단계적으로 처리한다.

## 6. 5단계 진입 체크

Windows 3단계 브랜치의 실제 코드 공유, 현재 서버 버전/manifest 충돌 처리, Neon 외부 백업 복구 시연, 미발견 PDF 3건 수동 검토, 삭제 후보의 모든 FK/다형/JSON 참조 조사, 모바일 동기화 tombstone/재접속 검수, 사용자 로그인 기반의 별도 영구 삭제 승인. 이 조건 전에는 실제 등록 및 영구 삭제 금지.

## 7. 소유자 웹 검토 화면 (후속 보완)

- `/desktop/connect`에서 소유자만 Windows 기기 키를 발급·철회하고, `/desktop/review`로 이동한다.
- `GET /api/desktop/catalog/review`는 로그인 소유자에게 속한 최근 manifest 최대 50건만 반환한다. 비밀 키·기기 토큰 해시와 원본 PDF 경로는 반환하지 않는다.
- `POST /api/desktop/catalog/review`는 소유자가 제출한 manifest의 수량·충돌·제외 상태와 연관 기록 건수만 읽는 dry-run이다. 다른 소유자의 manifest는 404로 차단한다.
- 웹 화면은 등록과 삭제 버튼을 제공하지 않는다. 3단계 Windows의 로컬 mock 요청은 서버에 제출되지 않았으므로 목록에 나타나지 않는 것이 정상이다.
- `tests/desktop-auth.test.ts`에서 기기 인증키의 서버 해시 저장, 읽기/쓰기 범위, 다른 소유자의 철회 차단, 철회 후 인증 차단을 검사한다.
- 운영 `db/035` 미적용 상태에서는 이 신규 화면을 배포하지 않는다. 최종 코드·테스트 검증과 main 병합은 운영 데이터 반영 계획과 분리한다.
