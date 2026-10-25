# 외부 배포용 DB 계정

2026-10-26: 온라인 화이트보드 저장이 보류되어 `028_whiteboard.sql`이 적용되지 않은 기존 설치에는 `enable-whiteboard-sync.sql`을 사용한다. 기존 자료를 지우지 않고 같은 테이블·변경 추적 트리거를 준비하며, 전용 앱 계정에 해당 테이블의 읽기·추가·수정만 허용한다. 반복 실행해도 보드 내용·기기 저장·전송 대기 기록을 초기화하지 않는다. 새 계정의 `provision-web-runtime.sql`은 전체 마이그레이션을 적용한 뒤 실행한다.

이 폴더는 자동 마이그레이션 대상이 아니다. 사용자가 전용 배포와 DB 연결을 승인한 뒤 운영자가 실행한다. 비밀번호나 접속 문자열을 파일·명령 인자·Git·로그에 넣지 않는다.

`provision-web-runtime.sql`은 새 `library_web_runtime` 역할을 **로그인 불가 상태**로 만든다. 이미 같은 역할이 있으면 실패하며 기존 권한을 바꾸지 않는다. 일반 자료에는 읽기·추가·수정, 수정 이력·가져오기·분석 피드백에는 읽기·추가만 허용한다. 삭제·DDL·역할 관리·인증 스키마·광범위한 상위 역할 멤버십은 주지 않는다. 기존 수집·마이그레이션 계정은 그대로 둔다.

승인 후 순서:

1. 지식서재의 해당 DB에만 이 SQL을 적용한다. 다른 앱 DB에서 실행하지 않는다.
2. 별도 암호를 생성해 비밀 환경에 저장하고, 해당 역할의 LOGIN을 활성화한다. 암호를 채팅이나 로그로 출력하지 않는다.
3. 새 접속으로 역할 속성과 멤버십을 다시 읽어 검증한다. `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION`, `BYPASSRLS`는 모두 false이며 상위 역할 멤버십은 없어야 한다. public 스키마 CREATE, DB CREATE, 도서 DELETE, 이력 UPDATE, 인증 테이블 SELECT가 없어야 한다.
4. 저장·읽기·수정 흐름을 별도 트랜잭션에서 검사하고 반드시 롤백한다. 기존 `scripts/verify-live.ts`는 스키마 CREATE만 검사하므로 3번 역할·상속 검사까지 대체하지 않는다.
5. 검증된 앱 전용 접속 URL만 전용 Vercel 프로젝트의 비밀 환경변수에 저장한다. 개발용 관리자 URL은 배포하지 않는다. 새 공개 주소에서 본인 로그인·다른 사용자 거절·Origin 검사를 수행한다.

실제 승인 전에는 로컬 시험 DB에서만 이 구성을 검증한다. `tests/runtime-privileges.test.ts`는 앱의 실제 저장 경로가 동작하고, 삭제·이력 변경·DDL·역할 상승·인증 자료 접근이 거절되는지 확인한다. 시험은 `SET SESSION AUTHORIZATION`으로 접속 역할을 모델링한다. 관리자 세션에서 `SET ROLE`만 쓰면 원래 관리자의 역할 전환 권한이 남으므로 권한 상승 검수가 잘못될 수 있다.

2026-10-15 읽기 전용 조사에서 기존 개발 접속 역할은 상위 `neon_superuser` 등의 권한을 상속했다. 기존 문서의 ‘명시적 GRANT가 좁다’는 내용만으로 실효 권한이 좁다고 판단해서는 안 된다.

2026-10-16 실제 `library` DB에 위 분리 구성을 적용했고 LOGIN을 활성화했다. 역할 속성·멤버십·허용/금지 권한을 재조회하고, 새 계정으로 실제 도서·메모 저장을 트랜잭션 롤백으로 검증했다. 기존 자료 변경은 없다. 자격 증명은 PC의 비공개 DPAPI 파일과 전용 Vercel 프로젝트의 production Secret에 보관한다. 같은 역할 생성 SQL을 다시 실행하거나 기존 작업자 계정을 교체하지 않는다. 실제 배포에는 제한 계정의 pooled URL만 연결했고 관리자 URL은 전송하지 않았다.

근거: [PostgreSQL 역할 속성](https://www.postgresql.org/docs/17/role-attributes.html), [역할 멤버십](https://www.postgresql.org/docs/18/role-membership.html).

## MCP 읽기 계정

`grant-mcp-read-runtime.sql`은 이미 생성한 전용 `library_mcp_remote_read` 역할의 읽기 권한과 접속 기본값을 관리한다. `library_active_notes`는 `security_invoker=true` 뷰이므로 원본 기록·휴지통 필터 테이블에도 SELECT가 필요하다. 도구는 이 뷰를 사용해 삭제된 기록을 제외하며 소유자는 서버에서 고정한다. 쓰기와 인증 토큰 테이블 접근은 허용하지 않는다.

Neon pooled URL에는 `options=-c statement_timeout=...`를 보내지 않는다. 풀러가 시작 패킷을 거절한다. 읽기 전용과 15초 제한은 역할 기본값으로 지정하고 실제 제한 계정의 새 접속에서 확인한다. 변경 후 `library_search`, `library_get_book`, `library_get_note`를 실제 클라이언트로 조회해 검증한다. 도구 목록 로딩만으로 검색 성공을 판정하지 않는다.
