# 검색 탭·소장본 연결 구현 계획

> Required: superpowers:executing-plans. User selected direct sequential execution in prior context.

Goal: 명확한 검색 탭과 실제 연결 동작을 제공한다.
Architecture: 기존 질의·검색 결과·공용 선택기 재사용, 서버와 기기 조건 일치.
Spec: docs/superpowers/specs/2026-10-25-search-tabs-relations-design.md
Constraints: 실제 개인 DB/동기화는11/1검수; 원본PDF·OCR·PC서버 변경 없음; API키/유료호출 변경 없음.
Review focus: 첫/기억 탭과 계정경계, 조건+페이지 전체 일치, 후보 비동기 응답/이전 책 선택 잔존, 원래 메모 입력 빈 도서 선택 호환, 모바일 드롭다운/모달 스크롤과 겹침.

1. 소장본 연결/선택기: 현재책 제외·첫 결과·페이지 항상 표시·‘연결’ 동작과 책 변경 상태를 모의 화면으로 재현해 RED→GREEN. 제외를 서버/기기 질의 전에 적용해 고립DB/로컬 질의로 검증한다.
2. 검색 탭/메모 검색: 저장 선택·검색가능한 주제/태그·도서 자동완성·필드 순서와 초기화/페이징을 모의 화면으로 RED→GREEN. 분야의 하위 KDC 분류도 검색하도록 서버/기기 질의 일치 검사한다.
3. 앱 검색/모달: 상단 전역 검색 제거, 소장도서 필드 추가 및 도서결과만 표시, 상세 제목 스크롤을 PC/휴대폰 크기에서 확인한다.
4. 관련 단위·모의 UI·타입 검사, 신선한 전체 코드 검토1회와 중요 결함 수정, GitHub/Vercel에 반영해 공개 정적 자산/빌드 확인. 실동기화 검수 목록과 운영 기록 갱신.
