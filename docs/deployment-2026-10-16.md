# 지식서재 웹 배포 및 데이터 처리 완료

운영 주소: https://knowledge-library-inky.vercel.app

사용자가 Vercel 기기 인증을 완료한 뒤 CLI의 로그인 성공을 확인했다. 확인된 동일 팀의 전용 `knowledge-library` 프로젝트를 만들고 Next.js 프레임워크를 명시했다. 기존 앱 프로젝트는 변경하지 않았다. 배포 ID `dpl_ETfA4dhEdZGchQdQkda9PUDPQN98`, 코드 `2e5e7c3`, 결과 READY. 비공개 GitHub 저장소 `LionDaniel79/knowledge-library`를 연결했다.

## 계정과 데이터 경계

- Google 인증에 기존 `http://127.0.0.1:3000`을 유지하고 `https://knowledge-library-inky.vercel.app`만 추가했다. 와일드카드는 사용하지 않았다.
- production Secret은 DATABASE_URL, NEON_AUTH_BASE_URL, NEON_AUTH_COOKIE_SECRET, LIBRARY_OWNER_EMAIL, APP_ORIGIN, LIBRARY_APP_ROLE이다. 값은 채팅·명령 인자·로그·Git에 출력하지 않았다. DB URL은 제한 역할 `library_web_runtime`의 pooled 접속이다.
- PDF·SQLite·실제 기록·개인 키 파일은 업로드에서 제외했다. 소스 약 2.1MB만 배포했으며 `.vercel/`과 `.env*`도 제외했다. OpenAI·Zotero·정보나루 작업은 기존 PC 설정을 사용한다.
- 실제 로그인 페이지 200, 비인증 서재 GET 401, 잘못된 Origin 저장 POST 403, 인증 없는 작업자 POST 401을 확인했다. Google 로그인 시작 200 → Neon 인증 중계 302 → accounts.google.com 흐름도 확인했다. 사용자가 본인 로그인 후 소장 도서 목록 표시를 확인했다.
- Vercel의 배포 보호 설정은 변경하지 않았다. 공유 Google OAuth 구성을 유지한다. 별도 Google OAuth 운영 자격 증명, 실제 휴대폰 설치/오프라인, Tailscale 원문 연결은 별도 검수 범위다.

## PDF 작업 완료

14:00 KST OCR 완료: 마지막 복구 실행 4,821쪽, 새 오류 0. 최종 일반 도서 1,475,338쪽 = 기존 텍스트 1,129,345 + 검증 전 OCR 330,604 + 인식된 글자 없음 15,389. 미처리 0쪽이다. OCR 정확도를 전수 검수한 것은 아니며 손상 PDF 7개는 별도로 남아 있다.

14:37 KST 후속 수집기 완료: 판본 검색·분류·내장/인쇄 목차·보존 검사 순서가 모두 종료됐다. 마지막 인쇄 목차 회차에서 61개 추가 반영, 총 후보 815개, 내장 목차 1,069개, 미발견 2,173개, 손상 7개. 미확인 판본과 검색 실패는 그대로 검토 대상으로 유지한다. 메모 157개·독서 이력 419개의 이전 해시와 일치했다. 유료 AI 호출 0.

## 백업과 검사

최종 온라인 25개 테이블을 D:/지식서재 백업/2026-10-16-final-library/에 저장하고 새 시험 DB에 복원해 차이 0건, 온라인 쓰기 0회 확인했다. 130,808,391바이트, SHA-256 33C0E30605E25754C1CD4FF9F6306ED1572AEA81FDBA0075082D4E308BEEA700. E:/지식서재 작업/private-data/backups/final-20261016/ 사본과 해시가 같고 두 드라이브는 서로 다른 물리 디스크다.

배포 설정을 반영한 GitHub 검사 38858117667도 통과했다. 단위·통합 247개와 브라우저 44개, 빌드를 포함한다. Linux에서 제외된 Windows 전용 검사는 PC에서 별도로 통과했다. 최종 PDF 색인/이미지 백업 검증은 별도 보고서로 기록한다. PDF 원본 약 362GB 전체의 독립 복사는 아직 하지 않았다.
