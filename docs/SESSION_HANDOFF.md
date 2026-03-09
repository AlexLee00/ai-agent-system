# 세션 핸드오프

> 다음 Claude Code 세션에서 이 파일을 먼저 읽어주세요.

## 이번 세션 완료 내역 (2026-03-10)

### 블로그팀 분할 생성(Chunked Generation) 완성

#### 구현 완료
- `packages/core/lib/chunked-llm.js` — callGemini / callGpt4o / chunkedGenerate 공용 유틸
- `bots/blog/lib/pos-writer.js` — `writeLecturePostChunked()` 추가 (4청크: group_a~d)
- `bots/blog/lib/gems-writer.js` — `writeGeneralPostChunked()` 추가 (3청크: group_a~c)
- `bots/blog/lib/blo.js` — `BLOG_LLM_MODEL` 환경변수 기반 분기 (두 함수 모두 적용)

#### 전환 방법
```bash
# 무료 Gemini Flash 분할 생성 (9,500자+ 목표)
BLOG_LLM_MODEL=gemini node bots/blog/lib/blo.js

# 유료 GPT-4o 단일 생성 (기본, 기존 동작)
BLOG_LLM_MODEL=gpt4o node bots/blog/lib/blo.js
```

#### 분할 생성 구조
| 파일 | 청크 수 | 청크 구성 |
|------|---------|---------|
| pos-writer (강의) | 4 | group_a: 인사말+브리핑(2000자+) / group_b: 이론(2000자+) / group_c: 코드(2000자+) / group_d: 홍보+FAQ+해시태그(1500자+) |
| gems-writer (일반) | 3 | group_a: 인사말+목차+본론1(2000자+) / group_b: 본론2+3(3000자+) / group_c: 홍보+마무리+해시태그(1500자+) |

#### 비용 비교
- GPT-4o: ~$0.12/편 (월 $6.60)
- Gemini Flash: $0 (무료 티어, 일 50회 한도)

#### 전제 조건
- `GEMINI_API_KEY` 환경변수 설정 필요 (Google AI Studio에서 발급)
- launchd plist에 `BLOG_LLM_MODEL=gemini` 추가 후 `launchctl unload/load`

---

## Phase 1 완전체 현황 (2026-03-09 이후 유지)

### 구현된 봇 (5봇)
- `bots/blog/lib/blo.js` — 팀장 오케스트레이션 + BLOG_LLM_MODEL 분기
- `bots/blog/lib/richer.js` — IT뉴스(HN)/Node.js릴리스(GitHub)/날씨(OpenWeatherMap) + RAG
- `bots/blog/lib/pos-writer.js` — 강의 포스팅 (GPT-4o 단일 OR Gemini 분할)
- `bots/blog/lib/gems-writer.js` — 일반 포스팅 (GPT-4o 단일 OR Gemini 분할)
- `bots/blog/lib/publ.js` — 마크다운 파일 저장 + DB + RAG + 구글드라이브 동기화

### 글자수 기준 (실측 기반)
- 강의 포스팅: 최소 7,000자 / 목표 8,500자 (분할생성 시 9,500자+ 가능)
- 일반 포스팅: 최소 3,500자 / 목표 6,000자 (분할생성 시 6,500자+ 가능)

---

## 다음 세션 할 일

### 블로그팀 Phase 2 후보
- [ ] GEMINI_API_KEY 설정 + `BLOG_LLM_MODEL=gemini` 실전 테스트
- [ ] launchd plist에 GEMINI_API_KEY / BLOG_LLM_MODEL 환경변수 추가
- [ ] 네이버 블로그 자동 발행 API 연동 (현재: 마크다운 파일 수동 복붙)
- [ ] 포스팅 성과 추적 (조회수/댓글 수집 → RAG 인기 패턴 학습)
- [ ] 도서리뷰 카테고리: 교보/예스24 API 연동

### 기타
- 맥미니 M4 Pro 도착 예정: 4월 중순 (이관 준비)
- 루나팀 Phase 3-A 크립토 OPS 안정화 모니터링 지속

---

## 현재 시스템 상태 (2026-03-10 기준)

| 팀 | 상태 | 주요 프로세스 |
|----|------|-------------|
| 제이팀 | ✅ OPS | OpenClaw 포트18789, 오케스트레이터 PID769, TG long-poll |
| 스카팀 | ✅ OPS | ai.ska.commander |
| 루나팀 | ✅ OPS (크립토) | ai.investment.crypto (PAPER_MODE=false) |
| 클로드팀 | ✅ OPS | ai.claude.dexter.quick(5분) + ai.claude.dexter(1h) |
| 블로팀 | ✅ OPS | ai.blog.daily (06:00 KST) |
| 워커팀 | ✅ OPS | ai.worker.web (포트4000) |
