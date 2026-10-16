# 외부 배포용 DB 계정

이 폴더는 자동 마이그레이션 대상이 아니다. 사용자가 전용 배포와 DB 연결을 승인한 뒤 운영자가 실행한다. 비밀번호나 접속 문자열을 파일·명령 인자·Git·로그에 넣지 않는다.

`provision-web-runtime.sql`은 새 `library_web_runtime` 역할을 **로그인 불가 상태**로 만든다. 이미 같은 역할이 있으면 실패하며 기존 권한을 바꾸지 않는다. 일반 자료에는 읽기·추가·수정, 수정 이력·가져오기·분석 피드백에는 읽기·추가만 허용한다. 삭제·DDL·역할 관리·인증 스키마·광범위한 상위 역할 멤버십은 주지 않는다. 기존 수집·마이그레이션 계정은 그대로 둔다.

승인 후 순서:

1. 지식서재의 해당 DB에만 이 SQL을 적용한다. 다른 앱 DB에서 실행하지 않는다.
2. 별도 암호를 생성해 비밀 환경에 저장하고, 해당 역할의 LOGIN을 활성화한다. 암호를 채팅이나 로그로 출력하지 않는다.
3. 새 접속으로 역할 속성과 멤버십을 다시 읽어 검증한다. `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION`, `BYPASSRLS`는 모두 false이며 상위 역할 멤버십은 없어야 한다. public 스키마 CREATE, DB CREATE, 도서 DELETE, 이력 UPDATE, 인증 테이블 SELECT가 없어야 한다.
4. 저장·읽기·수정 흐름을 별도 트랜잭션에서 검사하고 반드시 롤백한다. 기존 `scripts/verify-live.ts`는 스키마 CREATE만 검사하므로 3번 역할·상속 검사까지 대체하지 않는다.
5. 검증된 앱 전용 접속 URL만 전용 Vercel 프로젝트의 비밀 환경변수에 저장한다. 개발용 관리자 URL은 배포하지 않는다. 새 공개 주소에서 본인 로그인·다른 사용자 거절·Origin 검사를 수행한다.

실제 승인 전에는 로컬 시험 DB에서만 이 구성을 검증한다. `tests/runtime-privileges.test.ts`는 앱의 실제 저장 경로가 동작하고, 삭제·이력 변경·DDL·역할 상승·인증 자료 접근이 거절되는지 확인한다. 시험은 `SET SESSION AUTHORIZATION`으로 접속 역할을 모델링한다. 관리자 세션에서 `SET ROLE`만 쓰면 원래 관리자의 역할 전환 권한이 남으므로 권한 상승 검수가 잘못될 수 있다.

2026-10-15 읽기 전용 조사에서 기존 개발 접속 역할은 상위 `neon_superuser` 등의 권한을 상속했다. 기존 문서의 ‘명시적 GRANT가 좁다’는 내용만으로 실효 권한이 좁다고 판단해서는 안 된다. 위 분리 구성은 준비됐지만 실제 온라인 역할 생성·로그인 활성화는 아직 실행하지 않았다.

근거: [PostgreSQL 역할 속성](https://www.postgresql.org/docs/17/role-attributes.html), [역할 멤버십](https://www.postgresql.org/docs/18/role-membership.html).
