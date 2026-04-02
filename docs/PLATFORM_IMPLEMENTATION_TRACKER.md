# 플랫폼 구현 추적 문서

> 마지막 업데이트: 2026-04-02
> 목적: 실제 코드 구현 상태와 커밋 이력 기준으로 개발 진행 상황을 추적한다.
> 원칙: 완료(날짜+근거) / 진행 중(현재+남은 것) / 미완료 3단계 분류
> 참조: docs/STRATEGY.md (전략), team-jay-strategy.md (상세 원본)

---

## 0. 현재 최우선 과제

- **OpenClaw**: Phase 1~3 완성 ✅ / Phase 4 코덱스 진행중 (alert resolve + mainbot 퇴역)
- **LLM 재편성**: 구현 완료 ✅ (수정 2건 포함)
- **RAG 경험 저장**: 코덱스 구현 완료 (미커밋, experience-store.js + CLI)
- **블로팀**: F7 강의 순서 버그 + P1~P5 코덱스 프롬프트 완료
- **D 분해**: 인프라+루나 (docs/strategy/luna.md + docs/DEVELOPMENT.md)
- **멀티에이전트 v2**: 전략 수립 완료 (docs/MULTI_AGENT_EXPANSION_v2.md)

---

## 1. 인프라 현황 (2026-04-01)

```
OPS: Mac Studio M4 Max 36GB — 24/7 운영 (2026-03-29 전환 완료)
  PostgreSQL 17 + pgvector (:5432) — 9 스키마
  Hub (:7788) — secrets-store.json(14섹션) / errors / pg-query / health
  MLX v0.31.1 (:11434) — qwen2.5-7b + deepseek-r1-32b + qwen3-embed-0.6b
  n8n (:5678), OpenClaw (:18789)
  launchd 56+ plist, deploy.sh cron 5분
  GitHub Actions CI (self-hosted runner, OPS ARM64)
  ai.write.daily (매일 07:00 KST 일일 리포트)

DEV: MacBook Air M3 24GB — Tailscale 연결 (2026-03-29 셋업 완료)
  4중 안전장치: .zprofile + config.yaml + hostname체크 + applyDevSafetyOverrides()
  SSH 터널 (포트 15432→OPS PG), Hub/MLX Tailscale 직접 접근
  PG_DIRECT=true → SQL Guard 우회 INSERT 가능

네트워크: Tailscale VPN (REDACTED_TAILSCALE_IP ↔ 100.66.201.86)

시크릿: secrets-store.json = Single Source of Truth
  config.yaml = 런타임 설정만 (git 추적, API 키 없음)
  reservation/worker secrets.json = 삭제됨 (Hub 경유)

LLM: 7/10 에이전트 로컬화 (OpenAI 429 대응)
  로컬: qwen2.5-7b (hermes/sophia/zeus/athena/nemesis/oracle)
  Groq+로컬폴백: kimi-k2→deepseek-r1-32b (루나)
  임베딩: Qwen3-Embedding-0.6B (1024차원, 로컬, $0)
```

---

## 2. 완료된 개발 축 (최신 → 과거순)

### 2026-04-01: Hub Secrets Store + LLM 최적화 + 임베딩 전환 + 스킬 전체

| 항목 | 상태 | 커밋/근거 |
|------|------|----------|
| Hub Secrets Store 아키텍처 변경 | ✅ | secrets-store.json=14섹션 SSoT |
| config.yaml API 키 제거 | ✅ | 런타임 설정만, git 추적 시작 (f268316) |
| reservation/worker secrets.json 삭제 | ✅ | Hub 경유 전환 (db9ea15) |
| 폴백 코드 제거 (Step 6) | ✅ | Hub 전용 (8db0e54) |
| llm-client.js Hub 경유 변경 | ✅ | initHubSecrets→loadSecrets (db9ea15) |
| llm-keys.js initHubConfig | ✅ | llm-fallback에서 자동 호출 |
| pre-commit hook 업데이트 | ✅ | config.yaml 허용, secrets-store.json 차단 |
| PG_DIRECT 옵션 | ✅ | DEV INSERT 가능 (10495dd) |
| LLM 로컬 전환 (7개 에이전트) | ✅ | local_fast/groq_with_local (7ef89b6) |
| llm-model-selector local 프로바이더 | ✅ | 3개 라우트 추가 |
| llm-fallback provider=local | ✅ | local-llm-client 연동 |
| 임베딩 로컬 전환 | ✅ | OpenAI→MLX Qwen3-Embedding-0.6B (3e0984d) |
| pgvector 차원 변경 (1536→1024) | ✅ | 4개 테이블 + HNSW 인덱스 |
| 재임베딩 1,691건 | ✅ | rag_operations+trades+tech+video |
| groq accounts 구조 수정 | ✅ | 문자열→객체 배열 |
| 공용 스킬 Phase 1 | ✅ | 4파일 328줄 (code-review, verify-loop, plan) |
| 공용 스킬 Phase 2 | ✅ | 7파일 742줄 (클로드팀+라이트) |
| 공용 스킬 Phase 3 | ✅ | 12파일 1,150줄 (나머지 11개) |
| 공용 스킬 Phase 4 | ✅ | loader.js + 6팀 config 등록 + 체크섬 자동화 |
| CI/CD self-hosted runner | ✅ | OPS ARM64 + quality-check.yml |
| 라이트 daily cron | ✅ | ai.write.daily plist (07:00 KST) |
| 공개 레포 보안 검사 | ✅ | 시크릿 노출 0건 |

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
| 팀별 CLAUDE.md | ✅ | 7개 생성 (investment/claude/reservation/blog/worker/video/orchestrator) |

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
| 블로팀 P1~P5 | ✅ 구현 완료 | F7 인덱스 리셋(55) + P1 분할생성 + P2 품질강화 + P3 프롬프트간소화 + P4 성과수집 + P5 RAG (d7ffff6, 2dab41a, 16a6e93) |
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
- [x] 라이트(Write) 구현 ✅ — 제이 직속, 문서 점검+CHANGELOG+일일 리포트 (ai.write.daily 07:00 KST)
  - 보강 계획 (CODEX_WRITE_ENHANCEMENT.md):
    - 코덱스 프롬프트 완료 감지 + 자동 archive/ 이동
    - TRACKER 신규 파일 자동 추가 (최대 5건)
    - 루트 문서 아카이브 후보 제안
    - 주간 문서 정리 리포트 (일요일)
- [x] OpenClaw Phase 1~3 완성 ✅ — 알람 단일 경로 + OAuth + Selector + 평가
- [ ] OpenClaw Phase 4: mainbot.js 퇴역 + alert resolve Standing Orders (코덱스 진행중)
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
packages/core/lib/llm-fallback.js
packages/core/lib/llm-logger.js
packages/core/lib/llm-model-selector.js
packages/core/lib/shadow-mode.js        — 섀도우 모드 (에이전트 alias 해석, 04-02)
bots/investment/nodes/helpers.js
bots/investment/nodes/index.js
bots/investment/nodes/l03-sentinel.js
bots/investment/scripts/run-pipeline-node.js
bots/investment/shared/pipeline-decision-runner.js
bots/investment/team/_deprecated/hermes.js
bots/investment/team/_deprecated/sophia.js
bots/investment/team/hermes.js
bots/investment/team/sentinel.js
bots/investment/team/sophia.js
bots/blog/lib/runtime-config.js
packages/core/lib/hiring-contract.js
packages/core/lib/competition-engine.js
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
bots/blog/lib/pos-writer.js — POS 작가 (P1 분할생성 + P3 프롬프트 간소화)
bots/blog/lib/gems-writer.js — GEMS 작가 (P1 분할생성 + P3 프롬프트 간소화)
bots/blog/lib/blo.js — 메인 봇 (P1~P5 통합)
bots/blog/lib/quality-checker.js — 품질 검증 (P2 섹션마커+AI탐지+코드검증)
bots/blog/lib/publ.js — 발행+성과수집 (P4 7일후 조회수/공감)
bots/blog/lib/richer.js — 정보수집+RAG (P5 실전사례 활용)
bots/blog/lib/category-rotation.js — 강의 번호 관리 (F7 발행검증)
bots/blog/context/POS_PERSONA.md — POS 참조문서 (P3 분리)
bots/blog/context/GEMS_PERSONA.md — GEMS 참조문서 (P3 분리)
bots/blog/scripts/collect-performance.js — 성과 수집 스크립트 (P4)
bots/blog/config.json — 운영 설정
```

### 클로드팀
```
bots/claude/src/dexter.js — 시스템 점검 (23개 체크, error-logs 추가)
bots/claude/lib/team-bus.js — 팀 버스
bots/claude/lib/checks/security.js — 보안 점검 (false positive 수정, 04-02)
bots/claude/lib/doctor.js — 자동 복구 (scanAndRecover 능동화, 03-30)
bots/claude/.checksums.json
```

### 스카/워커/오케스트레이터
```
bots/reservation/auto/monitors/ — 네이버/픽코 모니터
bots/reservation/manual/reports/pickko-alerts-resolve.js — 미해결 알람 해제 CLI (--list/--recent 추가, 04-01)
bots/reservation/lib/mainbot-client.js — mainbot 큐 폴백 (Phase 3에서 postAlarm 전환)
bots/ska/src/forecast.py — 매출 예측
bots/worker/web/server.js — 워커 웹
bots/orchestrator/src/router.js — 제이 라우터 (isPickkoAlertResolveCommand → OpenClaw 전환 예정)
bots/orchestrator/src/mainbot.js — 알람 큐 처리 (Phase 4 퇴역 예정)
bots/orchestrator/src/filter.js — 알람 필터링 (Phase 4 Standing Orders 이전 예정)
bots/orchestrator/scripts/experience-store-cli.js — RAG 경험 저장 CLI (04-02 신규)
bots/orchestrator/CLAUDE.md — Claude Code 컨텍스트 (04-02 신규)
bots/orchestrator/lib/write/doc-archiver.js
bots/orchestrator/lib/write/doc-sync-checker.js
bots/orchestrator/src/write.js
bots/worker/lib/ai-client.js
bots/worker/lib/llm-api-monitoring.js
bots/orchestrator/config.json
bots/orchestrator/lib/jay-model-policy.js
bots/orchestrator/lib/runtime-config.js
bots/worker/web/app/admin/agent-office/page.js
bots/worker/web/components/AdminQuickNav.js
bots/worker/web/routes/agents.js
bots/worker/lib/menu-policy.js
bots/worker/web/components/Sidebar.js
bots/worker/web/lib/menu-access.js
bots/orchestrator/scripts/seed-blog-agents-phase2.js
bots/orchestrator/migrations/008-competitions.sql
bots/worker/web/components/AgentCharts.js
```

### RAG + 자기학습
```
packages/core/lib/experience-store.js — 에이전트 경험 triplet 저장/검색/통계 (04-02 신규)
packages/core/lib/rag.js — pgvector RAG (rag_experience 컬렉션 추가, 04-02)
~/.openclaw/workspace/skills/self-improving/ — 자기학습 스킬 v1.2.16 (04-02 설치)
~/self-improving/ — 자기학습 메모리 (memory.md, corrections.md, domains/)
```

---

## 6. 핵심 아키텍처 결정 기록

| 날짜 | 결정 |
|------|------|
| 04-02 | self-improving 스킬 설치 + RAG 경험 저장 설계 (pgvector triplet) |
| 04-02 | 블로팀 F7: 강의 번호 점프 발견 (17건 미발행, 인덱스 리셋 필요) |
| 04-01 | OpenClaw Phase 1~3 완성: 알람 단일 경로 (webhook + OPS 프록시) |
| 04-01 | OAuth OpenClaw CLI 경유 + 팀별 Selector 공용화 + 모델 평가 |
| 04-01 | 전체 56 에이전트 LLM 모델 재편성 (변경9, Fallback5, Selector1) |
| 04-01 | Phase 4 설계: exec+Skill+Standing Orders A안 (mainbot 퇴역) |
| 04-01 | n8n 불필요 확정 (현 단계, v2 멀티에이전트 확장 시 재도입) |
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
| 2026-04-02 | 라이트 제안 반영: 신규 파일 6건 추적 추가 (experience-store, pickko-alerts-resolve, mainbot, filter, orchestrator scripts). 아키텍처 결정 7건 추가 (Phase 1~3, OAuth, 모델 재편성, Phase 4, n8n, self-improving, F7). 현재 과제 갱신. |
| 2026-03-31 | 749줄→~200줄 대폭 압축. 03-19 이후 12일간 변화 반영. 맥미니→맥스튜디오, Ollama→MLX, Chronos Phase A, 문서 체계 v2, 블로팀 딥분석, 에러 해소 |
| 2026-03-19 | 초기 작성 (749줄) |
