# 플랫폼 구현 추적 문서

> 마지막 업데이트: 2026-03-31
> 목적: 실제 코드 구현 상태와 커밋 이력 기준으로 개발 진행 상황을 추적한다.
> 원칙: 완료(날짜+근거) / 진행 중(현재+남은 것) / 미완료 3단계 분류
> 참조: docs/STRATEGY.md (전략), team-jay-strategy.md (상세 원본)

---

## 0. 현재 최우선 과제

- **Chronos**: Layer 2~3 검증 완료 → Tier 2 본격 구현
- **블로팀**: P1~P5 코덱스 프롬프트 작성 → 구현
- **옵션B**: 스카팀 reservation Phase E 설계
- **OpenClaw**: Phase 1 mainbot.js 흡수
- **문서**: D 전략 통합 (STRATEGY.md v4 심화)

---

## 1. 인프라 현황 (2026-03-31)

```
OPS: Mac Studio M4 Max 36GB — 24/7 운영 (2026-03-29 전환 완료)
  PostgreSQL 17 + pgvector (:5432) — 9 스키마
  Hub (:7788) — secrets/errors/pg-query/health
  MLX v0.31.1 (:11434) — qwen2.5-7b + deepseek-r1-32b (2026-03-31)
  n8n (:5678), OpenClaw (:18789)
  launchd 56+ plist, deploy.sh cron 5분, GitHub Actions CI

DEV: MacBook Air M3 24GB — Tailscale 연결 (2026-03-29 셋업 완료)
  4중 안전장치: .zprofile + config.yaml + hostname체크 + applyDevSafetyOverrides()
  SSH 터널 (포트 15432→OPS PG), Hub/MLX Tailscale 직접 접근

네트워크: Tailscale VPN (REDACTED_TAILSCALE_IP ↔ 100.66.201.86)
```

---

## 2. 완료된 개발 축 (최신 → 과거순)

### 2026-03-31: Chronos Phase A + 문서 체계 v2

| 항목 | 상태 | 커밋/근거 |
|------|------|----------|
| MLX 인프라 (OPS) | ✅ | Ollama 제거→MLX v0.31.1, launchd(ai.mlx.server) |
| Chronos Layer 1~3 (DEV) | ✅ | 79b0d73 (711줄/9파일) |
| Layer 1 검증 | ✅ | 121캔들→49신호→2거래 |
| Layer 2 검증 (qwen) | ✅ | 49신호 감성분석, 90.6초 |
| Layer 3 검증 (deepseek) | ✅ | 3신호 종합판단, 189초 |
| local-llm-client.js | ✅ | packages/core/lib/ 공용, OpenAI 호환 |
| 문서 체계 v2 | ✅ | 7대 카테고리, 79파일 아카이브 |
| CLAUDE.md 리팩터링 | ✅ | 367→116줄 (68% 축소) |
| STRATEGY.md v4 | ✅ | 159줄 신설 |
| 팀별 CLAUDE.md | ✅ | 6개 생성 |

### 2026-03-30: 블로팀 딥분석 + 루나팀 에러 해소 + DEV↔OPS 환경

| 항목 | 상태 | 커밋/근거 |
|------|------|----------|
| 블로팀 딥분석 7,467줄/25파일 | ✅ | docs/strategy/blog-analysis.md (245줄) |
| 블로팀 F1~F6 발견 + P1~P5 수립 | ✅ | 85153b0 |
| crypto 최소수량 SELL 해소 (142건/시간→0) | ✅ | 55b4519 (roundSellAmount try-catch) |
| domestic tradeMode 해소 (12건→0) | ✅ | 579b3b2 |
| P5 Secret Hub Connector 전체 | ✅ | 30ed168 (14개 init, 4중 안전장치) |
| OPS 관측성 19/19 | ✅ | 3206c13 (Hub errors + hub-client + 덱스터 + 닥터) |
| DEV↔OPS 환경 분리 (P1~P5) | ✅ | env.js 공용, Hub, CI/CD, DEV 셋업 |
| 맥북 에어 DEV 셋업 100% | ✅ | 4중 안전장치 적용 |

### 2026-03-29: 맥 스튜디오 전환 + 루나팀 P1 + Tier 1

| 항목 | 상태 | 커밋/근거 |
|------|------|----------|
| 맥 스튜디오 운영 전환 | ✅ | 56 plist + DB + 에이전트 전부 가동 |
| P1 코드 수정 7/7 | ✅ | PnL 0건 MISMATCH |
| P1-10 EXIT 경로 | ✅ | SELL 4건, LIVE 2건 normal_exit |
| Tier 1 5/5 | ✅ | 최소수량 스킵, sentinel, EXIT→ENTRY, 공통 모듈, heartbeat |
| GitHub Public + BFG 보안 | ✅ | API키/chat_id/이메일 history 제거 |
| 자동 배포 체계 | ✅ | deploy.sh cron 5분 + GitHub Actions |

### 2026-03-15~19: 공용 엔진 + 운영 안정화 (이전 세션)

| 항목 | 상태 | 근거 |
|------|------|------|
| Health Engine (공용) | ✅ | packages/core/lib/health-provider.js, health-db.js |
| Intent Engine (공용) | ✅ | packages/core/lib/intent-core.js |
| Reporting Hub (공용) | ✅ | packages/core/lib/reporting-hub.js |
| AI Feedback Layer | ✅ | ai-feedback-core.js + worker/blog/claude 연결 |
| 워커 AI 정책/권한 UX | ✅ | ai-policy.js, menu-policy.js, PromptAdvisor |
| 팀별 runtime_config 외부화 | ✅ | 6팀 전부 config.yaml/config.json 외부화 |
| 스카 예측 엔진 + shadow 비교 | ✅ | forecast.py, knn-shadow-v1 |
| n8n 운영/경로 안정화 | ✅ | setup-client, webhook-registry, critical path |
| LLM selector + advisor | ✅ | llm-model-selector.js, llm-selector-advisor.js |
| 루나 decision 퍼널 계측 | ✅ | pipeline_runs.meta |
| 투자 validation 레일 | ✅ | trade_mode normal/validation 분리 (현재 normal 통합) |
| 알림 모바일 UX 최적화 | ✅ | telegram-sender 15자 구분선, 축약 규칙 |

---

## 3. 진행 중인 개발 축

| 항목 | 현재 상태 | 남은 것 |
|------|----------|---------|
| Chronos Tier 2 | Phase A 완료, Layer 1~3 동작 | 전략 최적화, VectorBT, walk-forward |
| 블로팀 P1~P5 | 딥분석+계획 완료 | 코덱스 프롬프트 작성→구현 |
| 워커 확인창 UX | 핵심 메뉴 1차 완료 | 캔버스 시각 마감, 관리자 위젯 심화 |
| 스카 shadow 관찰 | 저장+리뷰 연결 완료 | MAPE gap 기준 ensemble 편입 |
| 피드백 RAG | 적재+유사사례 조회 완료 | 품질 랭킹, training export |
| 문서 체계 v2 | 디렉토리+파일 정리 완료 | STRATEGY.md 심화 (D 작업) |

---

## 4. 미완료 개발 축

### 루나팀
- [ ] Chronos Tier 2: VectorBT + walk-forward + strategy_registry
- [ ] 검증 3단계 (Shadow→Confirmation→Live)
- [ ] DCA 전략 + 펀딩레이트 + 그리드
- [ ] sentinel 통합 (sophia+hermes→sentinel.js)
- [ ] Nemesis 분해 (Hard Rule + Budget + Adaptive Risk)

### 블로팀
- [ ] P1 날씨 수치 제거 + P2 품질 검증 강화
- [ ] P3 프롬프트 최적화 + P4 hallucination 방지
- [ ] P5 SEO-AEO-GEO + 실전 발행

### 스카팀
- [ ] n8n node화 2차 (write/ops 계열)
- [ ] RAG retrieval 활용 강화
- [ ] 옵션B (reservation Phase E)

### 워커팀
- [ ] SaaS 본격 개발 (채팅+캔버스 패턴)
- [ ] Cloudflare Tunnel 외부 접속

### 공통
- [ ] OpenClaw Phase 1: mainbot.js 흡수
- [ ] ComfyUI + 이미지 비용 $0 전환
- [ ] TS Phase 1: TypeScript 강화
- [ ] TS Phase 2: Elixir 오케스트레이션
- [ ] Claude Code Skills/Subagents/Hooks 도입

---

## 5. 팀별 빠른 찾기

### 공용 계층
```
packages/core/lib/env.js              — 환경 분기 (DEV/OPS)
packages/core/lib/pg-pool.js          — PostgreSQL 연결
packages/core/lib/hub-client.js       — Hub API (secrets/errors/pg-query)
packages/core/lib/local-llm-client.js — MLX 로컬 LLM (OpenAI 호환)
packages/core/lib/kst.js              — 한국 시간 유틸
packages/core/lib/health-provider.js  — 공용 헬스
packages/core/lib/reporting-hub.js    — 공용 알림/리포트
packages/core/lib/ai-feedback-core.js — AI 피드백 루프
packages/core/lib/rag.js              — pgvector RAG
```

### 루나팀
```
bots/investment/team/luna.js(963줄)    — 팀장
bots/investment/team/nemesis.js(954줄) — 리스크
bots/investment/team/chronos.js(346줄) — 백테스팅
bots/investment/shared/db.js(906줄)    — DB
bots/investment/shared/ohlcv-fetcher.js(175줄) — OHLCV 수집
bots/investment/shared/ta-indicators.js(61줄) — 기술지표
bots/investment/config.yaml            — 운영 설정
```

### 블로팀
```
bots/blog/lib/maestro.js(342줄) — 팀장/오케스트레이터
bots/blog/lib/pos-writer.js(632줄) — POS 작가
bots/blog/lib/blo.js(714줄) — 메인 봇
bots/blog/config.json — 운영 설정
```

### 클로드팀
```
bots/claude/src/dexter.js — 시스템 점검 (22개 체크)
bots/claude/lib/team-bus.js — 팀 버스
```

### 스카/워커/오케스트레이터
```
bots/reservation/auto/monitors/ — 네이버/픽코 모니터
bots/ska/src/forecast.py — 매출 예측
bots/worker/web/server.js — 워커 웹
bots/orchestrator/src/router.js — 제이 라우터
```

---

## 6. 핵심 아키텍처 결정 기록

| 날짜 | 결정 |
|------|------|
| 03-31 | Ollama→MLX 전환 (20~50% 빠름, arXiv 2511.05502) |
| 03-31 | local-llm-client.js → packages/core/lib/ 공용 (Hub 경유 안 함) |
| 03-31 | Kimi K2: 128GB 필요→불가 / 70B: 스왑→32B 유지 |
| 03-31 | 문서 체계 7대 카테고리 확정 |
| 03-31 | STRATEGY.md v4: Self-Healing+Self-Evolving+Recursive Science+Bounded Autonomy |
| 03-30 | DEV↔OPS 환경 분리 4중 안전장치 |
| 03-29 | 맥미니→맥 스튜디오 M4 Max 전환 완료 |
| 03-29 | GitHub Public 전환 + BFG 보안 정리 |
| 03-28 | 루나팀 재설계 방향: 13→11에이전트, 4전략 |
| 03-08 | pgvector (PostgreSQL 확장) — 별도 벡터 DB 금지 |

---

## 7. 변경 이력

| 날짜 | 변경 |
|------|------|
| 2026-03-31 | 749줄→~200줄 대폭 압축. 03-19 이후 12일간 변화 반영. 맥미니→맥스튜디오, Ollama→MLX, Chronos Phase A, 문서 체계 v2, 블로팀 딥분석, 에러 해소 |
| 2026-03-19 | 초기 작성 (749줄) |
