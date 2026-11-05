# 지식서재 5단계 — PDF 자동 보관 차단 및 가역 복원 안전 정책

검증 기준일: 2026-11-04 (KST). 코드 브랜치: `feat/stage5-windows-https-v2` / PR #8 (PR #7에 종속).

## 1. 사실과 검토 근거

- Neon QA `stage5-qa-2026-11-03`의 기존 PDF 9,321건과 봉인된 Windows manifest 4,108건을 읽기 전용으로 대조.
- 선택 정상 4,072 / 선택 기존 제외 36(논문 31, 간행물 4, 사용자가 삭제한 도서 1) / 미선택 기존 제외 5,173 / 미선택 제외되지 않은 40.
- Codex 검증 커밋 `a193673`: 76건 중 원본 73건의 전체 SHA-256 일치, 3건은 실물 미발견. 미선택 37건은 이동된 서울대 철학사상연구소 연구 별책으로 확인.
- 사용자가 후속 확인한 세 자료: 과거 `나사, 그들만의 방식 1.pdf`와 `나사2.pdf`는 현재 선택된 `나사 그들만의 방식.pdf`로 합쳐졌고, 별도 `마틴 루터 킹 연설.pdf`는 사용자가 삭제함. PDF 내용의 바이트 단위 역재구성은 수행하지 않았음.
- 기존 도서의 제외 결정은 **현재 Windows의 폴더 선택 상태와 독립적**이며 우선해서 보존한다.

## 2. PR #8 서버 정책

- `src/server/pdf-retention-policy.ts`: 기존 문서와 도서 ID, 현재 제외 사유를 바탕으로 미선택 PDF를 목록화하고 `heldUnselectedBooks`, `heldReviewBooks`, `heldOtherBooks`, `previouslyExcludedBooks`를 분리한다.
- 현재 **미선택·미제외 도서는 전부 승인 대기**다. 자동으로 새 `pdf_archive` 제외 기록을 만들지 않는다. 37건 연구 별책과 3건 사용자 정리 자료는 예외적 추측 없이 이 정책에 포함된다.
- `src/server/pdf-retention.ts`: 선택된 기존 사용자 제외(도서/논문/간행물) 36건의 `library_book_exclusions` 행은 건드리지 않고, 필요한 `library_pdf_registry` 등록 상태만 기록한다. 문서와 도서의 ID를 변경하거나 PDF/OCR을 이동·삭제하지 않는다.
- 기존에 명시적으로 `pdf_archive`로 제외된 도서를 재선택한 경우에 한해 `state='restored'`로 변경 가능하다. 그 외 제외 사유는 자동 복원하지 않는다.
- 이전에 등록되었다가 선택 범위 밖에 남은 PDF라도, 해당 도서가 실제 `pdf_archive/excluded`가 아니라면 `library_pdf_registry.state='archived'`로 자동 변경하지 않는다.
- `previewDesktopManifest`는 사용자 보호 제외 36건과 복원 가능한 `pdf_archive`를 **서로 다르게 집계**한다. 구형 `archiveBooks`·`expectedArchiveBooks`는 기존 API 호환용 *전체 미선택 수*이며 **신규 자동 보관 수를 의미하지 않는다**. 신규 자동 보관 가능 수는 `automaticallyArchivableBooks=0`이다.
- `LIBRARY_STAGE5_WRITE_ENABLED`가 `true`가 아니면 어떤 apply도 403 차단; 마이그레이션·실제 보관·등록은 별도 승인 전 금지. `canApplySelection=false` 및 `canDelete=false` 미리보기 유지.

## 3. 시험/검증 범위

- `tests/pdf-retention-stage5-safety.test.ts`: 새 DB를 만드는 **PGlite 전용 가상 79건**(선택 36 제외 + 선택 정상 1 + 선택 이전 pdf_archive 1 + 미선택 37 연구 + 3 정리 + 미선택 기존 제외 1)로 실제 76건 예외 패턴을 시뮬레이션.
- 도서·문서 ID 유지, 제외 사유/버전 보존, 메모·독서 기록·서지 검토·참고 출처·도서 연결 관계의 행 체크섬 비교, 적용 재시도, 복원, 소유자별 모바일 동기화 변경 추적 검사.
- `tests/pdf-retention-stage4.test.ts`: 미선택 신규 자동 보관의 차단과 **이전 승인 pdf_archive의 원래 ID로 복원** 시험.
- `.github/workflows/stage5-retention-safety.yml`: TypeScript 검사와 Stage4/Stage5 PDF 계약, 모바일 memo/replica 및 sync-retention PGlite 테스트를 지속 실행.
- 이 검증은 실제 운영/Neon QA 데이터에 쓰지 않으며 원본 PDF·OCR·SQLite에 접근하거나 수정하지 않는다.

## 4. 남은 출시 차단 조건

1. 운영 Neon과 독립된 **외부 백업을 만든 뒤 실제 복원**하여 도서·메모·독서 기록·연결 관계 및 변경 이력의 체크섬 보존을 증명.
2. 신규 보관 대상이 정말 필요한 경우 **개별 소유자 검토 및 승인된 도서 ID allowlist를 담은 별도 작업 절차**를 구현한다. 현재 정책은 fail-closed이므로 신규 `pdf_archive`를 생성하지 않는다.
3. QA와 운영의 데이터 시차를 점검하고 현재 문서 ID/버전 manifest를 다시 확인한다.
4. 실제 배포 전 모바일 동기화 종단 간 점검. CI는 로컬 격리 DB/모의 기기 수준의 회귀검사이며 모바일 실기기 동기화의 대체물이 아니다.
5. 승인된 운영 적용 전까지 PR #7·#8 병합, 운영 배포, `LIBRARY_STAGE5_WRITE_ENABLED=true` 설정 금지.

## 5. 안전 결론

사용자 제외 36건과 미선택·미제외 40건을 **자동 상태 전환하지 않고 보존**하는 정책이다. 이 상태만으로는 자동 보관 및 실제 데이터 전환 승인이 아니다.
