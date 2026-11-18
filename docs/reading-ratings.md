# 독서 별점

- 새 별점은 `library_cycles.source_data.readingRating.steps`에 정수 0~10으로 저장한다. 화면에는 2로 나누어 0~5점을 표시한다.
- `steps: 0`은 실제 0점, `steps: null`은 평가 안 함이다. 미평가는 평균에서 제외한다. 평가를 지우면 이전 가져오기 별점이 다시 나타나지 않는다.
- 기존 시작일·완독일·쪽수·원본 가져오기 JSON을 유지한다. 별점만 수정하는 `rateReading` 명령은 날짜를 변경하지 않는다. 기존 날짜 수정 API에서 별점을 생략하면 보존한다.
- 기기 동기화와 백업은 기존 `source_data` 경로를 사용한다. 새로운 테이블·열이나 백업 형식 변경은 없다. `043_reading_ratings.sql`은 값의 범위만 검증한다.
- 통계는 선택 기간에 완독한 책마다 최근 완독 회차 한 건을 사용한다. 날짜 없는 완독은 전체 기간에 포함하고 연도별 목록에는 포함하지 않는다. 도서 상세정보는 페이지에 필요한 도서만 조회한다.

## iReadItNow 자료

보존된 `raw.ZRATING`의 1~10은 반 별 단위로 해석한다. 회차 별점을 우선하며 책에만 있는 별점은 최신 완독 회차에 한 번만 연결한다. 과거 원자료의 0은 평가하지 않은 기본값과 구별할 근거가 없으므로 미평가로 유지한다. 새로 선택한 0점은 별도 키로 확실히 구분된다.

향후 독서 이력을 가져올 때 변환하며, 이미 가져온 자료는 아래의 소유자 한정 도구로 연결한다. 기존 사용자 별점과 평가 해제는 덮어쓰지 않으며 기존 수정 이력·동기화 트랜잭션을 사용한다. 재실행 시 이미 연결한 기록은 건너뛴다.

## 운영 반영 순서

1. 검증된 변경 코드의 배포를 결정한다.
2. 기존 DB 연결로 `db/043_reading_ratings.sql`만 적용한다. 검증된 기존 마이그레이션 실행 경로에도 등록되어 있다.
3. 기존 비공개 환경설정을 사용하여 `scripts/import-reading-ratings.ts`를 실행해 소유자와 후보 집계를 확인한다. 기본은 미리보기다. 연결 문자열이나 원자료를 출력하지 않는다.
4. 동일 도구에 `--apply`를 추가해 기존 가져오기 별점을 연결한다. 새 도서·독서 회차는 생성하지 않고 수정 이력을 남긴다.
5. 배포 후 대표 완독 도서, 0점·미평가 저장, 별점 통계를 확인한다. 실기기 간 확인 전에는 동기화를 실기기 검증 완료라고 보고하지 않는다.

## 관련 검증

- `npx vitest run tests/reading-ratings.test.ts tests/undated-completion.test.ts tests/legacy-reading.test.ts tests/recent-reading-query.test.ts tests/replica-outbox.test.ts tests/library-backup.test.ts tests/sync-commands.test.ts`
- `npx tsc --noEmit`
- `npx playwright test --config playwright.ratings.config.ts`: 운영 서버 없이 격리된 브라우저에서 완독·반 별·0점·미평가·재시도·날짜 없는 완독·모바일/PC 통계 검증.
- `npm run build`
