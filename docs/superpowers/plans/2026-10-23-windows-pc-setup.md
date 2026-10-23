# Windows PC Setup Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for direct sequential implementation.

**Goal:** 기존 서재의 새 Windows PC를 실행 파일로 구성한다.
**Architecture:** native WinForms 설정 화면, 암호화 연결 파일, PowerShell 설치 작업자, 범용 Node 서버 런처, 기존 트레이 재사용.
**Tech Stack:** .NET Framework 4.8, Windows PowerShell 5.1, Node 24.22.0, Python 3.13.16.
**Spec:** docs/superpowers/specs/2026-10-23-windows-pc-setup-design.md

## Global Constraints

- 기존 PC 작업과 비밀정보를 배포물에 포함하지 않는다.
- 본인 Windows 사용자 DPAPI; 내보내기는 제한 DB 역할·로그인·서지 키만.
- Node 공식 ZIP SHA256 검증; Python 공식 서명 검사.
- 127.0.0.1 고정, 기존 작업/포트 보존, 설치만으로 OCR·수집 실행 금지.
- 새 PC 본인 로그인·권한 승인과 실제 신규 기기 미검수는 명시.

## Review Focus

- 다른 암호/파일 변조를 복호화 전에 거부하는가.
- 설정 값이나 경로로 명령 삽입·압축 경로 탈출이 가능한가.
- 실패 뒤 설정 파일·로그에 키가 남는가.
- 재실행이 기존 서버 작업/색인/사용자 소스를 교체하는가.
- 새 PC에서 Codex 설치 없이 실행할 수 있는가.

## Tasks

- [x] 1. SetupCore.cs + SetupTests.cs: 연결 정보 allowlist, DPAPI 및 암호화 왕복/오류, 경로·프로필 검증. RED → GREEN.
- [x] 2. setup-worker.ps1 + start-private-pc.mjs: 경로/패키지 검증, 공식 런타임, 환경 준비, 런처·예약 작업·트레이. PowerShell 구문 및 격리 런처/설정 검증.
- [x] 3. SetupForm.cs + build-setup.ps1: 연결 파일 내보내기/가져오기와 새 PC 구성 화면. GUI·중복 설치 방어·실패 안내 검사.
- [ ] 4. package-setup.ps1 + 사용자 안내: 추적된 소스만 묶은 ZIP, 해시와 출처 고정, EXE·스크립트 배포. 내용과 비밀 제외 검사.
- [ ] 5. 전체 변경 독립 검토, 필요한 수정, 테스트·문서·커밋, 실행 파일 제공.

## 검증 기록

- 연결·암호화 27개 검사, 실제 기존 보호 설정의 메모리 내 호환성 검사, 작업자 20개 검사, Node 런처 4개 검사, Windows 통합 8개 검사를 통과했다.
- 별도 공식 Node·Python을 사용해 환경을 구성했다. Python의 PDF·Windows OCR 의존성과 서명을 확인했다.
- 개인정보와 .env 파일이 없는 새 앱 폴더에서 의존성 설치와 Next 16.4.2 빌드를 통과했다. 기존 16.4.0의 공식 보안 수정은 배포 전에 반영했다.
- 같은 격리 폴더의 전체 앱 테스트는 498개 통과·1개 건너뜀이다. 앱 설치에는 PowerShell 7이 필요 없으며, 기존 개발용 상태 파일 검사의 실행 도구만 테스트 환경에 추가했다.
- 독립 검토에서 실행 경로, 중단된 압축 해제 복구, Tailscale 기존 설정 보존, 설치 실패 시 자동 작업 복구, 재부팅 뒤 중복 실행 방지, 외장하드 재연결, 빌드 완료 확인을 보완하고 재검증했다. 남은 Critical·Important 지적은 없다.
- 실제 다른 Windows PC의 최초 설치·Google 로그인·관리자 승인·재부팅 확인은 이 PC의 격리 시험으로 대체할 수 없어 사용자 안내에 남겼다.
