# 지식서재 5단계: Windows Codex ↔ Vercel 보호된 QA 연동

> 2026-11-03. QA-only. 운영 배포, 운영 Neon, PDF 원본/OCR/검색 색인과 로고스는 변경 금지.
> 이 인계서는 PR #8 `feat/stage5-windows-https-v2`의 **최신 HEAD를 pull한 뒤** 사용한다.

## 1. 검증된 서버·저장소

- GitHub: `LionDaniel79/knowledge-library`, 브랜치 `feat/stage5-windows-https-v2`, PR #8 (PR #7 위의 스택형 PR).
- 독립 Vercel 프로젝트: **`knowledge-library-stage5-qa`**. 운영 `knowledge-library`와 별개.
- Neon 데이터베이스: **`personal-knowledge-library` 프로젝트 / `stage5-qa-2026-11-03` 브랜치 / `library` 데이터베이스 / `library_web_runtime` 역할**. 운영 `feat-library-mvp` 브랜치와 구분.
- 서버의 `DATABASE_URL`은 QA 프로젝트의 **Preview**에만 Sensitive로 등록됨. 운영 프로젝트로 복사하지 않는다.
- QA 프로젝트는 Vercel 로그인 보호 **all**. Windows `http.client`는 Vercel SSO 쿠키를 자동 제공하지 않으므로 QA 전용 **Vercel Automation Bypass**와 **QA Windows bearer** 두 자격증명을 별도로 사용한다. 하나라도 없으면 전송하지 않는다.
- `LIBRARY_STAGE5_WRITE_ENABLED=false`, `LIBRARY_MCP_REMOTE_ENABLED=false`, `LIBRARY_SERVER_ASSIST_ENABLED=false`.
- 개발자 검증 완료: QA Preview에서 진짜 Next.js API → QA Neon `start/items/seal/preview` 가상 1건 E2E 정상; 토큰 및 임시 우회키는 시험 후 **철회됨**. 당시 사용한 키는 재사용 불가.
- Windows 최신 코드가 반영된 **새 QA Preview 배포 URL**만 사용한다. 이전 `...nstl03x48...`은 과거 커밋의 테스트 주소이며 새 기능을 반드시 포함하지 않는다.

## 2. 인증을 서로 구분하여 발급

**Windows QA 기기 bearer — Windows PC 안에서 생성**

1. 실제 QA Preview URL을 관리자와 별도 확인한다. `$testOrigin = 'https://<검증된-QA-Preview-host>'` (끝에 `/` 없음).
2. PowerShell 환경변수 `$env:KL_STAGE5_TEST_ORIGIN = $testOrigin`을 설정.
3. `New-QADeviceCredential.ps1 -TestOrigin $testOrigin` 실행. Windows 사용자 DPAPI에 32바이트 난수 bearer를 암호화 저장한다. **bearer 평문은 GitHub·ChatGPT·콘솔에 출력하지 않는다.**
4. 출력된 **`qaOrigin`, `deviceId` (UUID), `tokenSha256` (64자 hex)**만 ChatGPT에 제출한다. ChatGPT는 **QA Neon 브랜치에서만** 동일한 도서 소유자에 해당 해시를 7일 제한·`catalog:read/write`로 등록한다. 토큰 원문을 요구하거나 보내지 않는다.
5. ChatGPT가 QA 등록 완료를 확인한 뒤에만 전송한다. 예전 QA 토큰은 사용하지 않는다.

**Vercel 로그인 보호 우회키 — QA Vercel 프로젝트 안에서 발급**

1. `knowledge-library-stage5-qa` 프로젝트의 Deployment Protection → Automation Bypass에서 QA 전용 임시 32자 secret을 생성한다. **기존 운영 `knowledge-library` 프로젝트에서 생성하거나 재사용하지 않는다.**
2. 이 비밀값은 **Windows PC의 `Test-ManifestPreview.ps1 -EnrollBypass -VercelProtected` 보안 프롬프트에만 입력**하여 별도 DPAPI 파일에 저장한다. ChatGPT·PR·로그·스크린샷에 붙이지 않는다.
3. 시험 종료 후 QA 프로젝트에서 우회 secret을 즉시 revoke한다. Windows 저장본은 삭제하거나 재사용하지 않는다.

Vercel 보호키와 Windows 기기 bearer의 **수명·저장소·헤더를 분리**한다. Windows 도구는 전자를 `x-vercel-protection-bypass`, 후자를 `Authorization: Bearer …`로 HTTPS 전송하며 명령행 인자나 환경변수에 비밀값을 넣지 않는다.

## 3. 최신 서버 도서 ID·버전 목록 확인

Windows 기존 3단계 SQLite `catalog_hint`에는 과거 단일 소유자 백업의 문서 ID·도서 ID·버전 정보가 들어 있다.

PR #8 신규 `POST /api/desktop/catalog/versions`은 owner-bound `catalog:read` 기기 키로 **최대 200개 기존 문서 UUID**를 받아, **`legacyDocumentId`, `bookId`, `expectedBookVersion`과 `verifiedAtUnix`**만 반환한다. 다른 소유자·누락 문서·비 PDF는 409로 중단하며 경로·서지·해시·PDF/OCR 원문은 반환하지 않는다.

Windows `api_v2.fetch_version_snapshot`은 200개씩 조회 후 로컬 catalog_hint와 **문서 UUID/도서 UUID/버전의 완전 일치**를 요구한다. 변경된 버전이나 다른 도서 ID를 자동 채택하지 않고 중단한다. `--refresh-version-export`는 사용자 개인 폴더에 이 가벼운 검산 JSON을 저장한다. `check_snapshot`은 1시간 넘은 자료를 거부한다.

**백업 복제 이후 원본 DB가 달라졌을 수 있으므로** 최신 운영 DB의 버전을 QA와 같다고 가정하면 안 된다. 일치하지 않는 경우 원인(로컬 백업·QA 복제 시점·신규 독서 기록/수정)부터 조사하되 운영 또는 QA 데이터를 임의 보정하지 않는다.

## 4. PC Codex에서 수행할 작업

1. 기존 작업 폴더의 변경분, PDF 원본, OCR, 검색 SQLite, 개인키 저장소를 백업하고 PR #8 최신 HEAD를 pull하여 컴파일/시험한다.
2. 문법 검사: `Test-ManifestPreview.ps1`, `New-QADeviceCredential.ps1`; Python `test_api_v2` 및 WPF 빌드·smoke를 실행한다.
3. 지정 루트 `E:\전자도서관\기독도서`, `E:\전자도서관\일반도서`를 읽기 전용 재스캔하여 실측 4,109개 물리 파일/4,108개 고유 문서 ID/추가 사본 1개를 **현재 상태로 확인**한다. 이전 수치를 강제하지 않는다.
4. QA URL 정확히 지정하고 `KL_STAGE5_TEST_ORIGIN`을 설정한다. QA 기기 토큰은 `New-QADeviceCredential.ps1`로 DPAPI 저장하고, **해시·기기 UUID만** ChatGPT에 전송하여 등록 확인받는다.
5. Vercel Automation Bypass를 별도 DPAPI 보안 입력으로 저장한다. `Test-ManifestPreview.ps1`에는 `-VercelProtected -EnrollBypass -RefreshVersionExport` 옵션이 있고, 첫 실행 뒤 재시도에는 `-EnrollBypass`를 생략한다. 로컬 기존 기기 키가 있으면 `-Enroll`로 덮어쓰지 않는다.
6. 단일 가상 문서 시험 또는 민감정보 없는 소규모 검증을 먼저 진행한다. 이후 **4,108개 고유 ID가 모두 QA 데이터베이스와 일치할 때만** 전체 manifest `start → items(≤200) → seal → preview`를 전송한다. 401/403/409/429/5xx 또는 인증·버전 불일치 시 즉시 중단·보고한다. 클라이언트는 리다이렉트를 따라가지 않고 TLS 인증서를 검증한다.
7. 실제 `apply-selection`, PDF 보관·삭제, 운영 DB 수정, `LIBRARY_STAGE5_WRITE_ENABLED=true` 설정은 **절대 실행하지 않는다**.

PowerShell 참고 (경로는 현장 확인하여 입력하며, 아래 전체 호출은 **한 줄**임):
```powershell
$testOrigin = 'https://<검증된-QA-Preview-host>'
$env:KL_STAGE5_TEST_ORIGIN = $testOrigin
.\New-QADeviceCredential.ps1 -TestOrigin $testOrigin
# 출력된 deviceId + tokenSha256만 ChatGPT에 보내 QA Neon 해시 등록을 요청한다.
$operation = [guid]::NewGuid()
.\Test-ManifestPreview.ps1 -TestOrigin $testOrigin -Operation $operation -VersionExport $privateVersionExport -Index $index -Root $pdfRoot -Directory $privateState -Python $python -VercelProtected -EnrollBypass -RefreshVersionExport
```
QA 키가 이미 DPAPI에 등록된 뒤 재시도할 때는 `-EnrollBypass`를 생략한다. QA 서버에서 401/403/409나 버전 불일치가 발생하면 **우회하지 않고 중단**한다. Credential 파일은 Windows 사용자 DPAPI에 묶여 있어 다른 PC로 복사해도 복호화할 수 없다.

## 5. 완료 보고

GitHub PR #8에 코드·테스트 변경을 커밋하고, 비식별 보고서에 다음만 기록한다: scan 완료 여부, 두 루트의 실측 건수, 고유 UUID 수, 충돌/누락 건수, `serverManifestId`(실제로 성공한 경우만), `acceptedItems`, `versionConflicts`, `itemsDigest`, `serverApplied=false`, 처리한 QA origin, commit SHA, pytest/PowerShell/WPF 검수 상태.

**금지 출력**: bearer, Vercel bypass, Neon 연결 문자열, 사용자 개인 이메일, PDF 절대 경로, 원문/OCR/개인 독서 기록, raw document UUID 목록.

## 6. QA / 운영 분리 검수 기준

- Vercel 프로젝트 `knowledge-library-stage5-qa`; `DATABASE_URL`은 Preview만 Sensitive.
- Neon QA 브랜치 `stage5-qa-2026-11-03`, 문서 기준 9,321건(기존), 시험 가상 문서 1건은 별도 QA owner. 실제 사용자 문서 9,321건의 ID·행 체크섬은 사전 검증과 동일.
- 운영 Neon 브랜치 `feat-library-mvp` 및 운영 Vercel 프로젝트 `knowledge-library`는 **변경 금지**.
- Windows 단계 완료 후 임시 기기 토큰·우회 인증 철회. PR #7·#8은 자동 병합하지 않는다.
