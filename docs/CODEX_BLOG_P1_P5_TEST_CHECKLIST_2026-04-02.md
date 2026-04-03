# CODEX_BLOG_P1_P5 테스트 체크리스트

작성일: 2026-04-02
대상: 블로팀 F7 + P1~P5

## 코드 점검

- [x] F7: `advanceLectureNumber()` 호출이 발행 이후 경로에만 남아 있는지 확인
- [x] F7: 재실행(`published.reused`) 시 인덱스 증가 생략 확인
- [x] P1: `writeLecturePostChunked()` / `writeGeneralPostChunked()` 기본 경로화 확인
- [x] P1: 분할 생성 실패 시 단일 생성 폴백 확인
- [x] P2: `checkQualityEnhanced()` 연동 확인
- [x] P2: 섹션 마커 / AI 리스크 / 패키지 검증 코드 확인
- [x] P3: `POS_SYSTEM_PROMPT`, `GEMS_SYSTEM_PROMPT` 경량화 확인
- [x] P3: `POS_PERSONA.md`, `GEMS_PERSONA.md` 분리 확인
- [x] P4: `recordPerformance()` 및 `views/comments/likes` 마이그레이션 초안 확인
- [x] P4: `getPerformanceCollectionCandidates()` 추가 확인
- [x] P4: `scripts/record-performance.js` 수동 수집 CLI 추가 확인
- [x] P5: `searchPopularPatterns()` 및 writer 입력 연결 확인

## 소프트 테스트

- [x] `node --check bots/blog/lib/blo.js`
- [x] `node --check bots/blog/lib/category-rotation.js`
- [x] `node --check bots/blog/lib/quality-checker.js`
- [x] `node --check bots/blog/lib/publ.js`
- [x] `node --check bots/blog/lib/richer.js`
- [x] `node --check bots/blog/lib/pos-writer.js`
- [x] `node --check bots/blog/lib/gems-writer.js`
- [x] `checkQualityEnhanced()` 짧은 강의 샘플 실패 판정 확인
- [x] `POS_SYSTEM_PROMPT.length = 126`
- [x] `GEMS_SYSTEM_PROMPT.length = 106`
- [x] `searchPopularPatterns` export 확인
- [x] `recordPerformance`, `getPerformanceCollectionCandidates` export 확인

## 하드 테스트

- [x] OPS 조회: `getNextLectureNumber() -> 56강` 확인
- [x] DEV `BLOG_TEST_MODE=true node bots/blog/scripts/run-daily.js` 실행
- [x] DEV `HUB_BASE_URL=http://127.0.0.1:17788` + `unset PG_DIRECT` 읽기 전용 E2E 완료
- [x] 강의/일반 2편 생성 완료, Google Drive 저장 완료, DEV에서 DB 저장/인덱스 증가는 생략 확인

## 하드 테스트 메모

- DEV 하드 테스트는 샌드박스 해제 후 실제로 실행했음.
- 외부 수집(`IT뉴스 5건`, `Node.js 3건`, 날씨 정상 수집)은 동작했음.
- DEV 검증은 로컬 DB 대신 OPS Hub(`127.0.0.1:17788`)를 읽기 전용으로 사용하도록 보정함.
- 실제 E2E 결과:
  - 강의 54강 글 생성 성공 (`21244자`)
  - 일반 글 생성 성공 (`9494자`)
  - Google Drive 저장 성공
  - `DEV/HUB 읽기 전용 — DB 저장 생략`, `인덱스 증가 생략` 로그 확인
- 같은 소스가 OPS에서는 기존 로컬 DB 쓰기 경로를 유지하고, DEV에서는 Hub 읽기 전용으로 안전하게 검증되도록 분리됨.
- 잔여 노이즈는 로컬 임베딩 서버(`127.0.0.1:11434`) 미기동으로 인한 RAG 인기 패턴/실전 사례 검색 실패 경고임.

## 남은 이슈

- [ ] `recordPerformance()`는 수동 CLI 경로는 준비됐지만 자동 수집 호출은 아직 없음
- [ ] DEV에서 로컬 임베딩 서버 또는 원격 임베딩 경로를 붙여 P5 RAG 검색까지 완전 검증 필요
