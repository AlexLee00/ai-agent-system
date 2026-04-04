# CODEX_BLOG_P4_P5_REMAINING 테스트 체크리스트

작성일: 2026-04-02  
대상: 블로팀 P4 자동 성과 수집 + P5 DEV 임베딩 연결

## 구현

- [x] `bots/blog/scripts/collect-performance.js` 생성
- [x] `bots/blog/launchd/ai.blog.collect-performance.plist` 생성
- [x] `bots/blog/lib/richer.js`에 네이버 블로그 성과 수집 헬퍼 추가
- [x] `packages/core/lib/local-llm-client.js`에 공용 base/embeddings URL helper 추가
- [x] `packages/core/lib/rag.js`가 `LOCAL_LLM_BASE_URL` 기반 임베딩 경로 사용하도록 수정
- [x] `bots/blog/lib/publ.js`에 OPS 미마이그레이션 폴백 추가

## 소프트 테스트

- [x] `node --check bots/blog/scripts/collect-performance.js`
- [x] `node --check bots/blog/lib/richer.js`
- [x] `node --check bots/blog/lib/publ.js`
- [x] `node --check packages/core/lib/local-llm-client.js`
- [x] `node --check packages/core/lib/rag.js`
- [x] `plutil -lint bots/blog/launchd/ai.blog.collect-performance.plist`

## 하드 테스트

- [x] DEV Hub 읽기 전용 dry-run:
  - `collect-performance.js --dry-run --limit=1 --json`
  - 후보 1건 조회 성공
  - 네이버 모바일 HTML 기반 stats 수집 성공 (`source=mobile_html`)
- [x] OPS DB 실조회:
  - 성과 수집 대상 `28건` 확인
  - `publish_date`/`metadata` 조건 SQL 직접 검증
- [x] DEV 임베딩 경로 확인:
  - `env.LOCAL_LLM_BASE_URL = http://REDACTED_TAILSCALE_IP:11434`
  - `/v1/models` 응답 성공
- [x] DEV `searchPopularPatterns('lecture')` 호출 성공
  - 엉뚱한 타팀 데이터 유입 방지를 위해 `team=blog`, `intent=blog_success` 필터 추가

## 메모

- OPS 문서에 적힌 `100.66.201.86:11434` 대신, 현재 코드 기준 공용 소스는 `env.LOCAL_LLM_BASE_URL`을 사용한다.
- DEV 기본값은 `http://REDACTED_TAILSCALE_IP:11434`이며, 이는 현재 실제로 응답하는 shared MLX endpoint다.
- `searchPopularPatterns('lecture')`는 호출 자체는 성공했고, 현재 blog_success 데이터가 충분하지 않아 결과 `0건`으로 확인됐다.
- `collect-performance`는 OPS에서 migration `005-post-performance-columns.sql` 이 아직 적용되지 않아도 `metadata` 기반으로 동작하도록 폴백했다.

## 배포 후 확인

- [ ] OPS에서 `node bots/blog/scripts/collect-performance.js --dry-run --limit=3 --json` 수동 확인
- [ ] OPS에 `ai.blog.collect-performance.plist` 배치 후 `launchctl load` 적용
- [ ] 다음날 21:00 KST 이후 `blog.posts.metadata.performance_collected_at` 기록 확인
- [ ] 이후 `blog_success` 데이터가 쌓이면 `searchPopularPatterns('lecture')` 결과가 1건 이상 나오는지 재확인
