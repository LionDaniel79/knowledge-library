# 외부 사용과 오프라인 기록

2026-10-14 구현 및 운영 기준. 온라인 배포, 개인 PC 연결, GPT 접근을 별도로 활성화한다.

## 현재 구현

- Google 로그인 후 확인된 본인 이메일만 자료에 접근한다. 모든 API에서 소유자를 확인한다. 자료 변경은 설정한 APP_ORIGIN과 요청 Origin이 같아야 한다.
- 온라인 DB에는 도서·기록·독서 이력·주제·저장된 소개와 목차가 있다. PDF 원본·본문 색인·OCR 작업은 E:에 남는다. 외부 서버에서 PDF 목록은 보이지만 원문 검색·열기는 PC 연결이 필요하다.
- 원문 접근 화면은 현재 서버의 PDF 연결 여부와 별도로 설정한 비공개 PC 링크를 표시한다. 원본 경로나 인증키는 반환하지 않는다. PC 링크는 파일·쪽수·인용 signature를 그대로 유지한다. 서버 간 임의 URL 프록시는 없다.
- PWA manifest와 공개 정적 오프라인 입력 화면을 제공한다. HTTPS 배포 후 지원 브라우저의 설치/홈 화면 추가로 사용한다. 서비스 워커는 공개 화면 4개만 보관한다. 로그인한 HTML, API 응답, PDF는 저장하지 않는다.
- 기록 작성/수정 창의 **기기에 임시 저장**은 계정별 브라우저 초안이다. 화면 아래 임시 기록에서 직접 서재로 보낸다. 응답 유실은 같은 요청 ID로 재시도한다. 다른 기기에서 먼저 수정했으면 두 글을 비교하고 합칠 글을 직접 쓰거나 새 생각으로 남긴다. 자동 덮어쓰기는 없다.
- 오프라인 새 기록은 개인 기기에서 사용 켜기를 선택한 뒤 이용한다. 로그아웃은 오프라인 사용 설정을 끄며, 기존 초안은 다시 같은 계정으로 로그인할 때 보인다. 기기 초안은 클라우드 백업이 아니다. 글 내려받기가 가능하다.

## 배포할 때 필요한 설정

GitHub의 지식서재 전용 비공개 저장소와 Vercel의 전용 프로젝트를 사용한다. 기존 목회 비서 등 다른 앱 프로젝트는 사용하지 않는다. Git에는 코드와 공개 문서만 올리고 `.env*`, `private-data`, PDF, SQLite, 백업, 실제 테스트 기록을 포함하지 않는다.

Vercel에는 앱 전용 권한의 DATABASE_URL, NEON_AUTH_BASE_URL, NEON_AUTH_COOKIE_SECRET, LIBRARY_OWNER_EMAIL, 확정된 HTTPS APP_ORIGIN을 비밀 환경변수로 설정한다. 관리자 DB URL·정보나루 키·PC 경로·OPENAI_API_KEY는 배포에 필요하지 않다. Neon Auth의 허용 origin과 Google 로그인 콜백은 실제 배포 주소에 맞춰 확인한다. 미인증·다른 계정·잘못된 Origin 요청이 차단되는지 확인한 다음 본인 휴대폰에서 로그인·기록·새로고침을 검수한다.

현재 연결 계정에서 지식서재 GitHub 저장소와 Vercel 프로젝트는 확인되지 않았다. 이 문서는 배포 완료를 뜻하지 않는다. 외부 공개 배포 및 계정 권한 설정은 검수된 코드가 준비된 뒤 별도 실행한다.

2026-10-15 추가 점검: 기존 개발 DB 접속은 상위 역할에서 넓은 권한을 상속하고 있다. 전용 배포 계정 구성은 [DB 운영 절차](../db/operations/README.md)에 저장했고 별도 시험 DB에서 저장 허용·삭제 및 권한 상승 거절을 검증했다. 실제 온라인 계정은 아직 만들지 않았다.

현재 Google 로그인은 Neon의 공유 OAuth 설정이다. 공식 문서는 이를 시험·프로토타입 용도로 설명한다. 외부 운영 주소에서는 허용 origin을 등록하고 로그인 검수와 전용 Google OAuth 자격 증명 필요 여부를 확인한다. 공유 설정만 확인한 상태를 운영 인증 완료로 표시하지 않는다. [Neon 공식 인증 개요](https://github.com/neondatabase/website/blob/main/content/docs/auth/overview.md).

## PDF를 위한 비공개 PC 접속

Tailscale **Serve**는 같은 개인 네트워크의 기기에서만 접속하는 HTTPS 경로다. **Funnel**은 인터넷 공개 방식이므로 사용하지 않는다. `.ts.net` 주소만으로 비공개 상태가 증명되는 것은 아니며 Serve 상태와 접근 정책도 확인해야 한다. [공식 웹 서버 공유 안내](https://tailscale.com/docs/share-web-server), [공식 Serve/Funnel 구분](https://tailscale.com/docs/features/tailscale-funnel/how-to/host-websites).

1. 본인 PC와 휴대폰을 같은 비공개 Tailscale 네트워크에 등록한다. 접근 정책은 본인 기기로 한정한다.
2. PC 앱은 127.0.0.1:3000에서 실행한다. Serve는 이 앱만 연결하고 E: 폴더 자체를 공유하지 않는다. 방화벽에 공개 포트를 만들지 않는다.
3. 발급된 HTTPS 주소를 PC 앱의 APP_ORIGIN과 Neon Auth 허용 주소에 반영하고 Google 로그인을 검수한다. 앱의 소유자 확인을 유지한다.
4. 온라인 앱의 LIBRARY_PC_ORIGIN에 해당 주소를 설정한다. Serve의 비공개 상태를 확인한 경우에만 LIBRARY_PC_PRIVATE_CONFIRMED=true로 설정한다.
5. PC·외장하드·앱이 켜진 상태와 꺼진 상태를 각각 시험한다. PC 연결이 끊겨도 온라인 기록은 독립적으로 이용한다.

현재 Tailscale 계정/기기 연결과 실제 HTTPS PC 주소가 없어 준비된 링크 흐름까지만 검수했다. 네트워크 접근 권한을 자동 생성하거나 원문을 공개하지 않았다.

## 개인 MCP

공식 SDK로 `library_search`, `library_get_book`, `library_get_note` 세 가지 읽기 도구를 구현했다. 서버 운영자가 고정한 소유자의 자료만 읽는다. 모델 입력으로 소유자를 바꿀 수 없고, 파일 경로·SQL·쓰기·임의 네트워크 도구는 없다. 검색 20건, 기록 본문 10,000자 한도와 잘림 표시, 원문 버전 검사를 제공한다.

기본적으로 꺼져 있다. 사용하려면 전용 읽기 DB 계정과 소유자 ID를 별도 비밀 환경에 설정하고 LIBRARY_MCP_ENABLED=true에서 `npm run mcp:stdio`를 사용한다. 연결 설정의 명령어에 비밀번호를 넣지 않는다. 런타임도 읽기 전용 트랜잭션과 15초 제한을 적용한다. 각 도구의 데이터는 외부 AI에 전달될 수 있으므로 연결할 클라이언트와 범위를 본인이 정한다.

이 구현은 데스크톱 클라이언트용 stdio다. ChatGPT의 원격 연결은 HTTPS MCP transport와 OAuth 제공자 등록이 추가로 필요하다. 원격 인증 없는 MCP 주소를 만들거나 GPT 계정에 자동 연결하지 않는다. [공식 TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server), [MCP 인증 사양](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

## 아직 실제 환경 확인이 필요한 항목

배포 URL과 로그인 콜백, 실제 휴대폰 설치/오프라인/재접속, Tailscale 등록, MCP 클라이언트 권한, GPT API 키·예산이 필요하다. 코드 검증과 실제 계정 활성화를 구분한다. API 키 없이 유료 AI 호출 시험을 하지 않는다.
