# 기존 서재에 Windows PC 추가

목적: 같은 사용자의 기존 온라인 서재와 외장하드를 새 Windows x64 PC에서 사용하도록 실행 프로그램으로 준비한다. 별도 사용자의 DB/웹 배포 생성은 이번 범위가 아니다.

사용자가 하는 일은 설치·자료 폴더 선택, 기존 PC에서 암호화 연결 파일 생성 및 새 PC에서 불러오기, Windows OCR 설치 권한 승인, Google/Tailscale 본인 로그인과 필요한 로그인 허용 주소 등록이다. 사용자는 터미널 명령, 환경 파일 편집, 코드 빌드를 하지 않는다.

설치 EXE + 함께 배포하는 파일 ZIP을 제공한다. 설정 화면은 연결 파일 만들기와 새 PC 설치를 제공한다. Node 24.22.0, Python 3.13.16은 공식 애플리케이션 로컬 ZIP으로 전개하고, 설치한 Python을 사용하므로 Codex 런타임을 참조하지 않는다. npm/pip 다운로드 및 빌드 캐시와 임시 작업은 선택한 자료 폴더에 둔다. 실행 코드·도구는 선택한 설치 폴더에 둔다. Windows 전체의 Python이나 PATH를 변경하지 않는다.

연결 파일은 최소 12자 암호, PBKDF2-HMAC-SHA256 200,000회, AES-256-CBC + 독립 HMAC-SHA256(암호문 인증 후 해독)으로 보호한다. 비밀번호·키는 명령행·로그·공개 패키지에 넣지 않는다. 가져온 연결 정보는 새 PC의 현재 Windows 사용자 DPAPI로 저장한다. 내보내기는 제한 권한 DB 계정과 로그인 설정, 선택적 도서 서지 API 키만 허용한다. 관리자 DB 계정·GPT 키·Zotero 키·기기 경로는 내보내지 않는다. 기존 보호 설정과 선택적인 .env 파일을 읽을 수 있다.

새 PC 설치는 패키지/다운로드 검증 → 도구 설치 → 소스 전개 → 의존성 설치·빌드 → DPAPI 설정 → 기존 트레이의 서버 작업/바로가기 등록 → 상태 확인 순서다. 다른 설치의 작업이나 점유 포트를 덮어쓰지 않는다. 실패 시 단계와 안전한 오류를 보여 주고, 관리 중인 동일 설치에서 재시도한다. 기존 서버·OCR·PDF·색인은 수정하지 않는다. 작업은 로그인 시 사용자 권한으로 실행하고 127.0.0.1에만 바인딩한다.

Tailscale은 같은 계정으로 로그인한 장치의 DNS 주소를 확인하며 Serve 연결을 명시적으로 설정할 수 있다. Funnel은 사용하지 않는다. 서버 주소가 새로 생기면 기존 로그인 서비스의 허용 주소 추가가 필요할 수 있다. 기존 Vercel의 기본 PC 링크를 자동으로 바꾸지 않는다. 기존 PC와 새 PC 중 어느 쪽을 기본 PDF 서버로 쓸지는 별도 선택이다.

전체 OCR/서지 수집은 설치만으로 시작하지 않는다. 기존 SQLite를 재사용하며 PC 종료 후의 개별 작업 재개는 앱의 기존 기능이다. 서버 자동 시작과 대량 작업 자동 재개를 구분한다.

테스트: 암호화 왕복·잘못된 암호·변조·비밀정보 제한·경로/압축탈출 방어·독립 도구 경로·런처의 loopback/설정 해독·기존 작업 보존·GUI 생성·배포 패키지 비밀 제외를 검사한다. 현재 PC의 운영 작업을 교체하는 설치는 하지 않는다. 새 PC/재부팅 실설치 미검수는 명시한다.

공식 참고: [Node 배포](https://nodejs.org/dist/v24.22.0/), [Python Windows 설치 옵션](https://docs.python.org/3.13/using/windows.html#installing-without-ui), [Windows 기능 설치](https://learn.microsoft.com/en-us/powershell/module/dism/add-windowscapability), [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).
