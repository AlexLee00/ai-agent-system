# 플랫폼 구현 추적 문서

> 마지막 업데이트: 2026-04-05
> 목적: 실제 코드 구현 상태와 커밋 이력 기준으로 개발 진행 상황을 추적한다.
> 원칙: 완료(날짜+근거) / 진행 중(현재+남은 것) / 미완료 3단계 분류
> 참조: docs/STRATEGY.md, docs/research/RESEARCH_CC_COMPREHENSIVE.md

---

## 0. 현재 최우선 과제

- **CC 패턴 P0**: 연속실패제한(llm-fallback.js) + Strict Write Discipline(rag.js)
- **자율 고용 전팀 확산**: 블로팀 ε-greedy → 전 팀 확대 (hiring-contract.js)
- **블로팀 Phase B**: 피드백 루프 (04-07~11 예정)
- **OpenClaw Phase 4**: mainbot.js 퇴역 + alert resolve Standing Orders
- **경쟁 결과 확인**: 첫 경쟁 결과 (월요일)
- **Gemma 4**: Ollama 테스트 (e4b + 26b MoE)
- **코덱스 정리**: 43개 완료→archive 이동 완료 (04-05), 6개 활성 유지
- **픽셀 오피스**: P1 DotCharacter 실시간 상태 반영 (커뮤니티 트렌드 반영)

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

### 2026-04-04: Phase A 기반안정화 + CC 유출 연구 + 자율 고용

| 항목 | 상태 | 커밋/근거 |
|------|------|----------|
| Phase A-1: ISBN 보충 + quality-checker warn | ✅ | 9936자 이슈0건, ISBN 9791186659489 |
| Phase A-2: ComfyUI MPS + FLUX 이중경로 | ✅ | 대표=FLUX, 나머지=SDXL |
| Phase A-3: blog-utils.js 공용 함수 추출 | ✅ | ea66034 (weatherToContext+estimateCost+loadPersonaGuide) |
| 블로팀 전략기획서 v2 | ✅ | blog-strategy-v2.md 382줄, 5Phase 로드맵 |
| Gemma 4 도입 검토 + 프롬프트 | ✅ | CODEX_GEMMA4_ROLLOUT.md (Ollama→MLX→본격) |
| 네이버 API/MCP 조사 | ✅ | 임시저장 불가, 현행 유지 |
| CC 유출 종합 연구 | ✅ | RESEARCH_CC_COMPREHENSIVE.md 163줄 (4파일→1파일) |
| 9팀 전수 분석 + 팀별 딥 분석 | ✅ | CC 하네스 6구성요소 비교 + Gap 14건 |
| 에이전트 하네스 + 서브에이전트 감독 연구 | ✅ | 5대 난제 + 감독 패턴 5가지 + 6대 원칙 |

### 2026-04-03: Phase 0~3 + 90에이전트 + Phase 6 스킬/MCP

| 항목 | 상태 | 커밋/근거 |
|------|------|----------|
| Phase 0.5: 53 신규 에이전트 (총 90) | ✅ | 연구15+감정10+데이터6+루나12+블로10 |
| 팀장 자율 고용 (ε-greedy, EPSILON=0.2) | ✅ | hiring-contract.js taskHint+specialty |
| 경쟁 시스템 활성화 (월/수/금) | ✅ | competition-engine.js (9abbfa5) |
| Phase B-1: JSONB 비파괴적 전환 | ✅ | 기존 데이터 마이그레이션+하드테스트 |
| Phase 2C: DotCharacter SVG+애니메이션 | ✅ | 0a23b65 |
| Phase 6: 3계층 동적 선택 | ✅ | skill-selector+tool-selector+pipeline |
| 스킬 31파일 + MCP 4파일 | ✅ | 공용16+다윈5+저스틴5+시그마5+블로2 |
| 런타임 셀렉터 전팀 분리 | ✅ | runtime-profiles 360줄 |
| 블로그 댓글 자동화 | ✅ | commenter.js 859줄 |
| 158파일 13,510줄 구현 | ✅ | CODEX_PHASE06_1~11 |

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
| 블로팀 Phase A~E | Phase A ✅ 완료 | Phase B 피드백루프 (04-07~11) |
| 자율 고용 전팀 확산 | 블로팀 ε-greedy ✅ | 루나/클로드/스카/워커/비디오 적용 |
| CC 패턴 적용 | 연구 완료 ✅ | P0 즉시 → P1~P3 순차 |
| Chronos Tier 2 | Phase A 완료, Layer 1~3 동작 | 전략 최적화, VectorBT, walk-forward |
| Phase 6 스킬/MCP | 158파일 구현 완료 | 런타임 검증 |
| LLM 모델 재편성 | 프롬프트 501줄 ✅ | 수정 2건 검증 |
| 워커 확인창 UX | 핵심 메뉴 1차 완료 | 캔버스 마감, 관리자 위젯 |
| 스카 shadow 관찰 | 저장+리뷰 연결 완료 | MAPE gap ensemble 편입 |
| Gemma 4 도입 | 검토 완료 | Ollama 테스트 → 2주 후 MLX |

---

## 4. 미완료 개발 축 (통합 우선순위)

### P0 — 즉시 (이번 주)
- [ ] CC: 연속실패제한 — llm-fallback.js MAX_FAILURES=5 (3줄)
- [ ] CC: Strict Write Discipline — rag.js 성공 시에만 메모리 기록
- [ ] 자율 고용: 루나팀 적용 (taskHint: crypto→chaineye, stock→funder)
- [ ] 자율 고용: 클로드팀 적용 (taskHint: monitoring→dexter, recovery→doctor)

### P1 — 단기 (04-07 ~ 04-18)
- [ ] 블로팀 Phase B 피드백 루프 (04-07~11)
- [ ] 자율 고용: 전 팀 Level 1 (ε-greedy) 확산 (스카/워커/비디오)
- [ ] CC: 야간 메모리 증류 — nightly-distill.js (autoDream 패턴)
- [ ] CC: 도구별 권한 레이어 — skill-selector permission (auto/approve/block)
- [ ] CC: 루나 독립 노드 병렬화 — l03+l04+l05 Promise.allSettled
- [ ] CC: Doctor 예방적 스캔 — 경고 징후 탐지
- [ ] GStack: 다단계 리뷰 게이트 — quality-checker 1단계(자동)+2단계(LLM)+3단계(마스터)
- [ ] GStack: Doctor에 "조사→진단→수정" 3단계 강제 (/investigate 패턴)
- [ ] 대규모 파일 분리: forecast.py 2,047줄 / chat-agent.js 876줄
- [ ] OpenClaw Phase 4: mainbot.js 퇴역 + alert resolve
- [ ] Gemma 4 Ollama 테스트 (e4b + 26b MoE)
- [ ] 블로팀 Phase C SEO+GEO (04-14~18)

### P2 — 중기 (04-21 ~ 05-09)
- [ ] 자율 고용: Level 2 태스크-스페셜티 매칭 전팀 적용
- [ ] CC: 컨텍스트 압축 — context-compactor.js (Micro+Auto)
- [ ] CC: Mailbox 패턴 — approval-queue.js (감정팀/루나팀 위험 작업)
- [ ] CC: AgentTool — agent-tool.js (에이전트 간 위임/스폰)
- [ ] CC: 에이전트 오피스 CC 메트릭 대시보드
- [ ] CC: autofix 3단계 권한 (safe/warn/block)
- [ ] GStack: Scope 관리 — 코덱스 프롬프트에 HOLD/SELECTIVE/REDUCE 지시
- [ ] GStack: Shadow Mode → 크로스 모델 리뷰 확장 (qwen vs gemma4)
- [ ] 대규모 파일 분리: edl-builder 971줄 / rebecca.py 937줄
- [ ] 스카: Python↔Node 인터페이스 표준화
- [ ] 블로팀 Phase D 콘텐츠 심화 (04-21~05-02)
- [ ] 경쟁 결과 → RAG 피드백 루프

### P3 — 장기 (05-05 ~)
- [ ] 자율 고용: Level 3 팀장 LLM 판단 (CrewAI 패턴)
- [ ] CC: KAIROS 자율 데몬 — 5분 주기 모니터링
- [ ] CC: 프롬프트 기반 오케스트레이션 — 코드→프롬프트
- [ ] CC: Build to Delete 아키텍처
- [ ] Chronos Tier 2: VectorBT + walk-forward + strategy_registry
- [ ] 블로팀 Phase E 자율 진화
- [ ] 비디오팀 Phase 3: CapCut급 타임라인 UI
- [ ] TS Phase 1: TypeScript 강화
- [ ] SaaS 본격 개발 (워커 채팅+캔버스)

### 기존 미완료 (팀별)

루나: 검증 3단계, DCA+펀딩레이트+그리드, sentinel 통합
스카: n8n node화 2차, RAG retrieval, 옵션B
워커: Cloudflare Tunnel 외부 접속
공통: ComfyUI 이미지 $0, TS Phase 2 Elixir, Claude Code Skills/Hooks

### 에이전트 픽셀 오피스 로드맵 (신규!)
- [ ] P1: DotCharacter에 실시간 상태 반영 (LLM호출중/대기/에러 애니메이션)
- [ ] P2: 토큰/비용 대시보드 (에이전트별 히트맵+차트)
- [ ] P2: 에이전트 오피스에 CC 메트릭 추가 (실패율/캐시히트)
- [ ] P3: 픽셀 오피스 풀 구현 (Phaser.js, 9팀 9개 오피스 방)
- [ ] P3: 서브에이전트 스폰 시각화
- [ ] P3: 오피스 레이아웃 에디터
- 참조: Pixel Agents(VS Code), AgentOffice(Phaser+Ollama), Star-Office-UI, Pixel Agent Desk

### 코덱스 파일 상태 (2026-04-05 업데이트)
- 완료 → archive 이동: 43개 (Phase1~6, Phase A, Blog P1~P5, 3대이슈, ISBN, 이미지 등)
- 활성 (진행중/미시작): 6개
  - CODEX_PHASE4_MAINBOT_OPENCLAW.md — mainbot 퇴역 (진행중)
  - CODEX_PHASE_B_TEAM_TRACKING.md — Phase B (04-07 시작 예정)
  - CODEX_GEMMA4_ROLLOUT.md — Ollama 테스트 중
  - CODEX_GEMMA4_ADOPTION.md — 미시작
  - CODEX_LUNA_SENTINEL_NEMESIS.md — sentinel 구현됨, nemesis 재설계 대기
  - CODEX_OVERSEAS_SELL_FIX.md — 미확인

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
bots/investment/team/hanul.js
bots/investment/shared/analyst-accuracy.js
bots/investment/shared/trade-journal-db.js
bots/investment/shared/llm-client.js
packages/core/lib/billing-guard.js
bots/investment/scripts/analyze-rr.js
bots/investment/scripts/trading-journal.js
bots/investment/scripts/weekly-trade-review.js
packages/core/lib/agent-registry.js
bots/blog/lib/commenter.js
packages/core/lib/skills/darwin/source-ranking.js
packages/core/lib/skills/index.js
packages/core/lib/skills/justin/citation-audit.js
packages/core/lib/skills/sigma/data-quality-guard.js
packages/core/lib/skills/loader.js
packages/core/lib/mcp/free-registry.js
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
bots/orchestrator/scripts/update-luna-agents.js
bots/worker/web/app/globals.css
bots/worker/web/components/DotCharacter.js
bots/orchestrator/scripts/seed-three-teams.js
bots/orchestrator/scripts/seed-blog-reinforce.js
bots/orchestrator/scripts/seed-team-reinforce-phase6.js
bots/orchestrator/scripts/team-skill-cli.js
bots/orchestrator/scripts/team-mcp-cli.js
bots/reservation/manual/reports/log-report.sh
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
| 04-04 | CC 유출 종합 연구: 하네스 6구성요소+5대 난제+감독 패턴 5가지 정리 |
| 04-04 | 자율 고용 3단계: ε-greedy(L1) → 태스크매칭(L2) → LLM판단(L3) 전팀 확산 |
| 04-04 | 블로팀 Phase A 완료, SDXL+FLUX 이중경로, 발행 현행 유지 |
| 04-04 | Gemma 4: Ollama 테스트 → 2주 후 MLX (26B MoE=M4 Max 최적) |
| 04-04 | 네이버 API: 임시저장 불가, MCP보다 직접 호출 적합 |
| 04-04 | CC 개선 로드맵 14건 수립 (P0~P3, RESEARCH_CC_COMPREHENSIVE.md) |
| 04-03 | Phase 0.5: 53 신규 에이전트 (90에이전트), 경쟁 월/수/금 |
| 04-03 | Phase 6: 3계층 동적 선택(Agent→Skill→Tool), 158파일 13,510줄 |
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
| 2026-04-05 | GStack+픽셀오피스+자율고용 연구 반영. 코덱스43개→archive. CC종합 14섹션→GStack포함. TRACKER P1~P2에 GStack 4건 추가. 출처 18→22건. |
| 2026-04-04 | Phase A 완료+CC유출연구+9팀딥분석+자율고용확산계획. 통합 우선순위 P0~P3 재정리. CC패턴14건+자율고용3단계+대규모파일분리5건. 연구4파일→1파일통합(163줄). |
| 2026-04-03 | 69커밋/158파일/+13510줄. Phase6 스킬/MCP/도구 3계층동적선택. 90에이전트(+53). P1수정(hermes→swift+role정규화+팀격리). JSONB팀추적. 런타임셀렉터. 댓글자동화. LLM정규화. 워크플로우엔진. CLI4개. |
| 2026-04-02 | 라이트 제안 반영: 신규 파일 6건 추적 추가 (experience-store, pickko-alerts-resolve, mainbot, filter, orchestrator scripts). 아키텍처 결정 7건 추가 (Phase 1~3, OAuth, 모델 재편성, Phase 4, n8n, self-improving, F7). 현재 과제 갱신. |
| 2026-03-31 | 749줄→~200줄 대폭 압축. 03-19 이후 12일간 변화 반영. 맥미니→맥스튜디오, Ollama→MLX, Chronos Phase A, 문서 체계 v2, 블로팀 딥분석, 에러 해소 |
| 2026-03-19 | 초기 작성 (749줄) |
