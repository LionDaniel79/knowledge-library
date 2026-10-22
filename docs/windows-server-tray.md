# Windows 서버 트레이

로그인하면 작업 표시줄 알림 영역에 책 모양 아이콘이 나타납니다. 숨겨져 있으면 시계 옆 **∧**를 누릅니다. 바탕화면의 **지식서재 서버** 바로가기로도 열 수 있습니다. 같은 프로그램을 다시 열어도 아이콘과 서버를 중복 실행하지 않습니다.

- 더블클릭 / **서재 열기**: PC 서재를 브라우저에서 엽니다.
- **서버 시작·다시 시작·중지**: 기존 비공개 PDF 서버의 Windows 작업을 제어합니다. 실행 정보·프로세스·실행 시각·명령·포트가 맞는 서버만 종료합니다.
- **서버 중지**는 기존 1분 간격 자동 복구도 일시 중지합니다. **서버 시작**으로 복구되며, 원래 등록된 로그인·재시도 규칙은 보존합니다. 다음 Windows 로그인 때 트레이가 서버 시작을 다시 요청합니다.
- 녹색: 실행 중, 회색: 중지, 주황색: 외장하드 연결 필요. 오른쪽 클릭 메뉴에서 상태와 서버 메모리를 확인합니다.
- **로그 폴더 열기**: PC 서버의 운영 기록 폴더를 엽니다.
- **트레이 아이콘 닫기**: 아이콘만 닫습니다. 서버 중지는 별도 메뉴입니다. OCR은 별도 작업입니다.

Windows 기본 .NET Framework와 WinForms를 사용하며, 별도 대형 실행 환경이나 AI 모델을 설치하지 않습니다. 트레이 프로그램·설정은 항상 연결된 PC 드라이브에 두고, PDF·색인은 기존 외장하드에 유지합니다. 설정 파일에는 경로와 기존 Windows 작업 정보만 저장하며 인증키를 담지 않습니다.

빌드: `desktop/windows/build.ps1 -OutputDirectory <빌드 폴더>`.
설치: `desktop/windows/install.ps1`에 빌드/설치 폴더, 기존 런타임 파일, 배포 폴더의 상위 경로, PDF 폴더, PC 서재 URL을 전달합니다. 기존 작업의 등록·트리거는 유지하고, 기존 시작프로그램 바로가기를 백업 후 트레이로 교체합니다. 바탕화면 바로가기도 생성합니다. 트레이를 먼저 닫은 상태에서 갱신합니다.

복원하려면 **서버 시작**으로 자동 복구를 다시 켠 뒤 트레이를 닫고, 새 시작프로그램 바로가기를 제거한 뒤 설치 폴더 `backup-*`의 `startup-legacy.lnk`를 원래 이름으로 복사합니다. 트레이를 실행할 수 없으면 기존 작업의 실행 경로를 확인한 후 PowerShell에서 `Enable-ScheduledTask -TaskPath '\' -TaskName 'KnowledgeLibrary-PrivatePDF'`를 실행합니다. PDF·색인·서버 계정 설정은 복원 대상에 포함되지 않습니다.

구현 참고: [Microsoft NotifyIcon](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.notifyicon), [Windows 작업 제어](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/nn-taskschd-iregisteredtask).
