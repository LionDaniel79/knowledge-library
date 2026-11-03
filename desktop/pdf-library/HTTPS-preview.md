# Windows HTTPS 시험 미리보기

WPF의 **HTTPS 전송 목록 점검**은 최신 완료 스캔과 현재 파일을 비교하고 예상 전송 수를 보여준다. 기존 **선택 목록 모의 검증**도 그대로 사용할 수 있다. 실제 시험 서버 호출은 아래 명령으로 분리했다.

1. 시험 서버 관리자가 발급한 시험용 HTTPS origin, 그 환경의 /desktop/connect 기기 키(catalog:read, catalog:write), 같은 소유자의 최신 버전 JSON을 준비한다. JSON은 신뢰하는 시험 관리자가 시험 DB에서 조회한 자료여야 한다. 이 전송 도구는 버전 자료를 발급하지 않는다. JSON 형식은 아래와 같다. verifiedAtUnix는 조회 시각(UTC epoch 초)이다. 로컬 시각 기준 한 시간 이내의 자료를 사용한다.

       {"origin":"https://test.example","verifiedAtUnix":0,"items":[{"legacyDocumentId":"<UUID>","bookId":"<UUID>","expectedBookVersion":1}]}

2. 별도 검산 사본을 지정하고 그 안의 도서 ID·버전과 위 자료가 일치하는지 확인한다. 최초 기기 키는 PowerShell 보안 입력창에 입력한다. Windows 사용자의 DPAPI와 시험 origin별로 키를 보관한다.

       $op = [guid]::NewGuid()
       .\Test-ManifestPreview.ps1 -TestOrigin $testOrigin -Operation $op -VersionExport $versionJson -Index $index -Root $pdfRoot -Directory $scanCopy -Python $python -Enroll

3. 중단 후에는 같은 자료와 같은 작업 UUID로 재실행한다. 이미 키를 저장했으면 -Enroll을 생략한다. 401/403이면 시험키와 권한을 확인하고 재발급받은 키는 -Enroll로 교체한다. 409 또는 버전 불일치 시 시험 서버와 매핑을 다시 대조한다. 미리보기만 제공하며, 등록·보관·삭제 호출은 구현하지 않았다.
4. 오프라인 검산 JSON은 python -B audit_v2.py INDEX PDF_ROOT SIDECAR 로 출력한다. acceptedItems는 실제 서버에서 확인한 수이고 versionConflicts가 null이면 서버 미검증이다. itemsDigest는 문서 목록의 계약 지문이다.

테스트: python -B -m unittest -v test_desktop test_api_v2. 서버 TypeScript와 digest를 대조하려면 저장소의 Node 개발 의존성을 설치한 환경에서 다음 명령을 사용한다.

    python -B -c "import json;from test_api_v2 import rows;from api_v2 import items_digest; r=rows(201)[::-1];print(json.dumps(dict(rows=r,digest=items_digest(r))))" | node verify-digest.cjs
