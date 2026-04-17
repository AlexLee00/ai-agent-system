# 세션 인수인계 — 2026-04-18 (CODEX_SIGMA_SHADOW_DEPLOY 38차 완전 검증)

> 세션 범위: Shadow Mode 전체 8단계 재검증 + 마이그레이션 경로 수정 + commit push

---

## 최신 작업 요약 (Shadow Deploy 38차 재검증)

`CODEX_SIGMA_SHADOW_DEPLOY` 8단계 전체 완료. OPS에서 Sigma Shadow Mode 가동 확인.

### 구현/변경 목록

- **마이그레이션 파일 복사**: `bots/sigma/migrations/*.exs` → `elixir/team_jay/priv/repo/migrations/` (mix ecto.migrations 파일 인식)
- **commit**: `62199fdd` — chore(sigma): priv/repo/migrations에 시그마 마이그레이션 파일 추가
- **환경변수 확인**: `.zprofile` SIGMA_* 7개 이미 설정됨, 값 모두 정확
- **plist**: `ai.sigma.daily` LaunchAgents 배포 완료, plutil lint OK
- **수동 실행**: shadow_run_id=4 생성, LastExitStatus=0
- **관찰 로그**: `docs/codex/SIGMA_SHADOW_OBSERVATION_LOG.md` Day 1 업데이트

### 검증 결과 (최종 39차)
- `mix compile --warnings-as-errors`: **0 warnings** ✅
- `mix test`: **116 tests, 0 failures** ✅
- `launchctl list ai.sigma.daily`: `LastExitStatus=0` ✅
- `launchctl list ai.elixir.supervisor`: PID=78289 ✅
- `sigma_v2_shadow_runs`: 5건 (HTTP 1회 + mix task 3회 + launchctl 1회) ✅
- HTTP /sigma/mailbox 응답 ✅ (포트 4010 정상)
- Tier 2 kill switch: `{:error, :tier2_disabled}` ✅
- `mix sigma.migrate`: 두 경로 모두 0건(all up) ✅
- plist plutil lint OK ✅
- match_score: `null/no_v1_pair` (v1 TS baseline 없음 — 정상)

### sigma-check alias 수정 필요 (수동)

`.zshrc` 권한 차단으로 코덱스 미수정. 수동으로:
```bash
# 기존 (오류): recent_match_rate/0 함수 없음
# 수정:
alias sigma-check='cd /Users/alexlee/projects/ai-agent-system/elixir/team_jay && mix run -e "Sigma.V2.ShadowCompare.daily_report() |> IO.inspect(label: \"daily_report\")"'
```

### 다음 단계 (7일 관찰)

1. **매일 21:30 KST** launchd 자동 실행 → shadow_runs 누적
2. **match_score 모니터링**: `daily_report()` 함수 사용 (recent_match_rate 아님)
   - 현재: no_v1_pair (v1 TS sigma-daily.ts 실행 시 자동 페어링)
3. **7일 후 결정**: 일치율 평균 95%+ → Tier 1 가동 준비
4. **OTel 파일**: `/tmp/sigma_v2_metrics.jsonl` (sigma_otel.jsonl 아님)

---

# 이전 인수인계 — 2026-04-18 (CODEX_SIGMA_PHASE_2_3_4_EXECUTE 완료 — Directive + Reflexion + ESPL)

> 세션 범위: Sigma V2 Phase 2 (Directive/Signal/Mailbox) + Phase 3 (Config/Reflexion/Self-RAG) + Phase 4 (ESPL/MetaReview/Grafana)

---

## 최신 작업 요약 (Phase 2~4)

`CODEX_SIGMA_PHASE_2_3_4_EXECUTE` 전체 Exit Criteria 달성.

### 구현 목록

- **Phase 2** (commit `c9aa7ca1`): Directive 프로토콜 + Archivist + Signal PubSub + 5팀 TS Signal Receiver + Mailbox + Graduation
- **Phase 3** (commit `31f5e69a`): Config snapshot/restore + RollbackScheduler + Reflexion + Self-RAG + Memory facade + LLM thin wrapper + Metric + TelegramBridge
- **Phase 4** (commit `4ae43bf3`): ESPL (E-SPL 진화) + Registry + MetaReview + Mailbox HTTP UI + Grafana dashboard + OTLP 텔레메트리
- **마이그레이션**: sigma_v2_mailbox / sigma_v2_config_snapshots / sigma_analyst_prompts (총 6개)
- **Kill Switches 기본 OFF**: SIGMA_TIER2_AUTO_APPLY / SIGMA_SELF_RAG_ENABLED / SIGMA_GEPA_ENABLED

### 검증 결과 (최종 — 2026-04-18 cont.)
- `mix compile --warnings-as-errors`: **0 warnings** ✅
- `mix test`: **116 tests, 0 failures** ✅ (Phase 2: 7, Phase 3: 11, Phase 4: 9 추가)
- 민감값 0건 ✅
- 버그 수정: `memory.ex` + `self_rag.ex` L2 threshold 누락 수정 (commit `79d33ca5`)
- CODEX 아카이브 완료: `docs/archive/codex-completed/CODEX_SIGMA_PHASE_2_3_4_EXECUTE.md`

### 주요 설계 결정
- Bandit port 충돌 방지: `port_available?/1` via `:gen_tcp.listen` (OPS와 test 환경 공존)
- Config 안전 게이트: ±20% 수치 필드 제약 (luna/ska/blog/worker/claude)
- Reflexion 결과 → `:procedural` 메모리 타입에 `AVOID:` 태그로 저장
- Self-RAG L2 연산: `operation: :retrieve` (`:recall` 아님 — 스키마 고정)

### 다음 단계 (CODEX_SIGMA_SHADOW_DEPLOY)

1. OPS `.zprofile`에 환경변수 5개 추가: `SIGMA_V2_ENABLED=true`, `SIGMA_MCP_SERVER_ENABLED=true`, `SIGMA_MCP_TOKEN=<비밀값>`, `SIGMA_HTTP_PORT=4010`, `SIGMA_TIER2_AUTO_APPLY=false`
2. `launchctl load` 또는 OPS mix 재시작
3. `mix ecto.migrate` — sigma_v2_mailbox / sigma_v2_config_snapshots / sigma_analyst_prompts
4. secrets-store.json에 MCP Token 등록
5. 21:30 KST 일일 Shadow 관찰 개시
6. 7일 일치율 95%+ 확인 → Tier 1 가동 결정

---

# 이전 인수인계 — 2026-04-17 (CODEX_SIGMA_LUNA_ALIGN 완료 — LLM Selector + 루나 표준 정비)

> 세션 범위: CODEX_SIGMA_LUNA_ALIGN Phase A~E 전체 완료 (이미 구현됨 확인 + Phase E 실행)

---

## 최신 작업 요약 (SIGMA_LUNA_ALIGN)

CODEX_SIGMA_LUNA_ALIGN 전체 Exit Criteria 달성. 아카이빙 완료.

### 확인된 완료 항목 (이미 커밋됨)
- **Phase A**: `bots/sigma/` 이동 작업 커밋 (commit `0fb5ffe3`)
- **Phase B**: 9개 표준 md (README/AGENTS/BOOTSTRAP/CLAUDE/HEARTBEAT/IDENTITY/SOUL/TOOLS/USER)
- **Phase C**: LLM Selector 모듈 — `bots/sigma/shared/` 4 TS 파일 + `bots/sigma/elixir/lib/sigma/v2/llm/` 2 ex 파일
- **Phase C-3**: `packages/core/lib/llm-model-selector.ts` — `sigma.agent_policy` (line 475) 추가
- **Phase C-5**: `bots/sigma/migrations/20260502000001_add_sigma_llm_cost_tracking.exs`
- **Phase D**: package.json / tsconfig.json / config.yaml.example / secrets.example.json

### 이번 세션 구현 (Phase E, commit `26cfff5f`)
- **5개 canonical SKILL.md 업그레이드**: Phase 0 skeleton → Phase 5 전체 문서 (agentskills.io 프론트매터 유지)
  - `bots/sigma/skills/data-quality-guard/SKILL.md` (v0.1.0 → v0.2.0, 132줄)
  - `bots/sigma/skills/causal-check/SKILL.md`
  - `bots/sigma/skills/experiment-design/SKILL.md`
  - `bots/sigma/skills/feature-planner/SKILL.md`
  - `bots/sigma/skills/observability-planner/SKILL.md`
- **uppercase 중복 5개 제거**: `bots/sigma/skills/*.md` (초기 생성 잔재)
- **codex 아카이빙**: `CODEX_SIGMA_LUNA_ALIGN.md` → `docs/archive/codex-completed/`

### 다음 단계 (OPS 배포 — Sigma Phase 1~5)

1. `cd elixir/team_jay && mix deps.get` (Plug + Bandit 신규 의존성)
2. `mix ecto.migrate` (Phase 0 audit + Phase 1 shadow_runs + Phase C sigma_llm_cost_tracking)
3. OPS `.env`에 `SIGMA_MCP_TOKEN=<비밀값>` 추가
4. `SIGMA_MCP_SERVER_ENABLED=true`로 HTTP 서버 기동 테스트
5. `mix test --only e2e`로 E2E 검증
6. Shadow Mode 7일 운영 후 ShadowCompare.weekly_report() → 95%+ 일치율 확인

---

# 이전 인수인계 — 2026-04-17 (CODEX_SIGMA_REMODEL_PHASE_5 완료 — 리모델링 최종)

> 세션 범위: TS 폐기 + MCP Server HTTP 노출 + 다윈 Signal Receiver + E2E 테스트

---

## 최신 작업 요약 (Phase 5)

CODEX_SIGMA_REMODEL_PHASE_5 전체 구현 완료. **시그마팀 리모델링 종결**.

### 구현 목록

- **TS 레거시 아카이브**: sigma-daily/scheduler/analyzer/feedback → `docs/archive/sigma-legacy/`
- **Thin Adapter**: `bots/orchestrator/src/sigma-daily.ts` (35줄, Elixir HTTP 위임)
- **mix.exs**: `plug ~> 1.16`, `bandit ~> 1.6` 추가 (Phoenix 미사용 환경에 맞춤)
- **HTTP Router**: `Sigma.V2.HTTP.Router` — `/sigma/v2/run-daily` + `/mcp/sigma/tools` 경로
- **MCP Server**: `Sigma.V2.MCP.Server` — 5개 도구 (agentskills.io 표준)
- **MCP Auth**: `Sigma.V2.MCP.Auth` — Bearer Token (SIGMA_MCP_TOKEN 환경변수)
- **Supervisor 개정**: `SIGMA_MCP_SERVER_ENABLED=true` 시 Bandit HTTP 서버 자식 기동
- **SKILL.md 5개**: `bots/sigma/skills/` 신규 디렉토리 (각 3~4KB, 7섹션 완비)
- **Darwin Signal Receiver**: `bots/darwin/src/signal-receiver.ts` (sigma advisory 구독)
- **E2E 테스트**: `test/sigma/v2/e2e_test.exs` (14 케이스: MCP + Auth + Skill 직접 호출)
- **완료 보고서**: `docs/SIGMA_REMODELING_COMPLETE.md`

### 다음 단계 (OPS 배포)

1. `cd elixir/team_jay && mix deps.get` (Plug + Bandit 신규 의존성)
2. `mix ecto.migrate` (Phase 1 마이그레이션 적용)
3. OPS `.env` 에 `SIGMA_MCP_TOKEN=<비밀값>` 추가
4. `SIGMA_MCP_SERVER_ENABLED=true` 로 HTTP 서버 기동 테스트
5. TS thin adapter: `SIGMA_V2_ENDPOINT=http://localhost:4000/sigma/v2` 확인
6. `mix test --only e2e` 로 E2E 검증

### 알림: Phoenix 없는 환경

코덱스는 Phoenix 기반 controller/router 구조를 제안했으나 현재 Elixir 앱은 순수 OTP (team_jay_web 없음). **Plug + Bandit**으로 동등한 HTTP 기능 구현. 포트 4000 동일.

---

# 이전 인수인계 — 2026-04-17 (CODEX_SIGMA_REMODEL_PHASE_1 완료)

> 세션 범위: Sigma V2 Elixir Jido 코어 + Shadow Mode 구현 (Phase 1)

---

## 최신 작업 요약

CODEX_SIGMA_REMODEL_PHASE_1 전체 구현 완료.
`mix compile --warnings-as-errors` 경고 0건. `mix test test/sigma/v2/skill/` 30개 모두 통과.

### 구현 목록
- **mix.exs**: `{:zoi, "~> 0.17"}`, `{:yaml_elixir, "~> 2.11"}` 명시적 추가
- **Skill 5개** (TS 1:1 포팅, Zoi 스키마):
  - `data_quality_guard.ex` — 중복/누락/신선도/이상값 (TS output 일치 확인)
  - `causal_check.ex` — 인과성 리스크 평가
  - `experiment_design.ex` — A/B 실험 설계
  - `feature_planner.ex` — 피처 우선순위
  - `observability_planner.ex` — OTel 계획
- **테스트**: `test/sigma/v2/skill/` 5개 파일, 30개 케이스 통과
- **Commander**: `use Jido.AI.Agent` + `decide_formation/4` + `analyze_formation/2` 구현
- **AgentSelector**: ε-greedy 에이전트 선택 (DB agent.registry)
- **Pod 3개**: `Risk` (hawk/optimizer), `Growth` (dove/librarian), `Trend` (owl/forecaster)
- **Memory L1**: ETS GenServer (put/get/clear/flush_to_l2)
- **Memory L2**: pgvector Jido.Action + Qwen3-Embedding-0.6B embed
- **Principle Loader**: YamlElixir + self_critique/2
- **Telemetry**: :telemetry.attach_many + handle_event + /tmp/sigma_v2_metrics.jsonl
- **Supervisor**: Memory.L1 등록 (SIGMA_V2_ENABLED=true 시)
- **ShadowRunner**: v2 편성 결정 + sigma_v2_shadow_runs DB 기록
- **ShadowCompare**: v1 vs v2 일치율 계산 + weekly_report/0
- **마이그레이션**: `20260501000001_add_sigma_v2_shadow_runs.exs`

### 다음 단계 (Phase 1 Exit Criteria 잔여)
- `mix ecto.migrate` 실행 (Phase 0 audit + Phase 1 shadow_runs 마이그레이션)
- Shadow Mode 7일 운영: `SIGMA_V2_ENABLED=false` (기본) 상태로 cron에서 `ShadowRunner.run()` 호출
- 7일 후 `ShadowCompare.weekly_report()` → 95%+ 일치율 확인 후 Phase 2 착수
- Phase 2: Directive Executor / Tier 적용 / Reflexion / E-SPL

---

## 이전 작업 (2026-04-17 루나팀)

> 세션 범위: CODEX_LUNA_IMPL I/J + OPS_TRANSITION Step 5 + KIS live 전환 + 자율 루프 확인

---

## 작업 요약

루나팀 CODEX_LUNA_IMPL 10개 구현 과제 전부 코드 완료.
KIS live 전환 (config.yaml kis_mode: live, 커밋 ffab4e5f).
OPS_TRANSITION Step 5: launchd 3개 plist 제거 — Elixir InvestmentSupervisor 인수 확인.
자율 루프: autonomous_cycle_events DB 이벤트로 mode3_manage readiness=ready 확인.

---

## ✅ 완료

### Blog Ops — Phase A~D (이전 세션 완료)
- token_renewal, publish_guard, topic_curator, quality-checker, feedback-learner, autonomy-gate
- insta-crosspost.ts (Phase D), weekly-evolution.ts 크로스포스트 통계
- TeamConnector do_collect(:blog) KPI 강화
- **OPS 마이그레이션 완료 (2026-04-17)**:
  - `bots/blog/migrations/011-topic-queue.sql` → blog.topic_queue ✅
  - `bots/blog/migrations/012-instagram-crosspost.sql` → blog.instagram_crosspost ✅

### CODEX_LUNA_AUTONOMOUS_LOOP Phase A/B
- `trading_loop.ex`: Mode 1(5분)/Mode 3(30초) 자동 타이머 루프
  - Mode 1→3 전환 시 타이머 교체, mode_tick 브로드캐스트

### CODEX_LUNA_OPS_TRANSITION (코드 완료, 실제 전환은 수동)
- `investment_supervisor.ex`: @investment_agents 20개 정의
  - env guard: `INVESTMENT_ELIXIR_ENABLED=true` 시 활성화
  - interval: commander/crypto/crypto_validation/health_check/unrealized_pnl/argos
  - calendar: domestic/overseas/validation×2/prescreen/reporter/scout/market_alerts×5
- `investment_scheduler.ex`: scout/domestic/overseas/validation 트리거 함수 추가
- `config.exs`: Quantum 스케줄 추가 (scout 2개, domestic, overseas 3개 — UTC)

### CODEX_LUNA_AUTONOMOUS_LOOP Phase C (브리지 완료)
- `capital-manager.ts`: `loadRuntimeOverrides()` + `getCapitalConfigWithOverrides()` 추가
  - investment.runtime_overrides 테이블에서 approved=true 오버라이드 로드
  - ALLOW 범위 클램프 6개 파라미터
- `strategy_adjuster.ex`: absolute value proposals + market_mode 구독
  - classify() → absolute proposals (RuntimeOverrideStore가 DB 저장)

### CODEX_LUNA_AUTONOMOUS_LOOP Phase D (헬스체크 실제화)
- `resource_feedback_coordinator.ex`: build_resources() 실제 HTTP ping
  - LLM: localhost:11434 ping, n8n: localhost:5678 ping

### CODEX_LUNA_AUTONOMOUS_LOOP Phase E (레짐 동적 전환)
- `strategy_adjuster.ex`: market_mode 구독 추가
  - 레짐별 tp/sl 자동 조정: trending(0.09/0.04), ranging(0.04/0.02), volatile(0.05/0.025)

### 아카이브 완료
- `CODEX_BLOG_AUTONOMOUS_OPS.md` → docs/archive/codex-completed/
- `CODEX_BLOG_OPS_HARDENING.md` → docs/archive/codex-completed/

---

## 🔜 다음 세션

### 루나팀 실제 전환 (수동 실행 필요)

**launchd → Elixir 리허설 순서:**
```bash
# 1단계: Elixir 활성화 (OPS에서 환경변수 설정 후 재시작)
export INVESTMENT_ELIXIR_ENABLED=true

# 2단계: 비위험 에이전트부터 launchd unload
launchctl unload ~/Library/LaunchAgents/ai.investment.health-check.plist
launchctl unload ~/Library/LaunchAgents/ai.investment.reporter.plist
# → Elixir PortAgent가 동일 작업 수행 확인

# 3단계: 알림 에이전트
launchctl unload ~/Library/LaunchAgents/ai.investment.market-alert-*.plist

# 4단계: 스크리닝
launchctl unload ~/Library/LaunchAgents/ai.investment.scout.plist
launchctl unload ~/Library/LaunchAgents/ai.investment.prescreen-*.plist
launchctl unload ~/Library/LaunchAgents/ai.investment.argos.plist

# 5단계: 매매 에이전트 (마스터 최종 확인 후)
launchctl unload ~/Library/LaunchAgents/ai.investment.crypto.plist
launchctl unload ~/Library/LaunchAgents/ai.investment.domestic.plist
launchctl unload ~/Library/LaunchAgents/ai.investment.overseas.plist
```

**해외장 mock SELL 검증 (작업 2):**
- 미국 개장 시간(22:30 KST) 직전 수동 실행

**~~LIVE 전환 체크리스트 (작업 3):~~** ✅ 완료 (커밋 ffab4e5f)
- ~~kis_mode: paper → live~~ → `config.yaml kis_mode: live` 확인됨 (마스터 승인 완료)

### ~~getCapitalConfigWithOverrides() 적용~~ ✅ 완료 (2026-04-17)
- `preTradeCheck()` 내 `getCapitalConfig()` → `await getCapitalConfigWithOverrides()` 교체 완료
- Elixir 런타임 오버라이드가 매매 전 체크에 실제 반영됨
- 파일: `bots/investment/shared/capital-manager.ts`

---

## ✅ 추가 완료 (2026-04-17 세션 연속)

- `preTradeCheck()` → `getCapitalConfigWithOverrides()` 연결 완료 (commit cae82236)
  - Elixir StrategyAdjuster → DB → capital-manager.ts 전체 체인 완성

---

### 남은 코덱스 (docs/codex/ 잔존)
- `CODEX_CORE_REINFORCEMENT.md` — Phase 3 Step 4 (agent memory 확장) → Phase 4 → Phase 5
- `CODEX_LUNA_OPS_TRANSITION.md` — Step 5 실행 대기 (crypto/domestic/overseas launchd 제거)
- `CODEX_LUNA_AUTONOMOUS_LOOP.md` — 코드 완료 → 실제 루프 연결 확인
- `CODEX_LUNA_PRODUCTION.md` — Elixir 활성화 완료, kis_mode live 전환은 마스터 승인 후
- `CODEX_LUNA_IMPL.md` — D(VectorBT)/E(TradingView)/G(스킬)/H(피드백) 미착수
- `CODEX_LUNA_REMODEL.md` — 별도 검토 필요 (대형)
- `CODEX_BLOG_COMPREHENSIVE.md`, `CODEX_BLOG_BOOK_SKILL.md` — 미착수

### 아카이브 완료 (docs/archive/codex-completed/)
- CODEX_LUNA_TS_CONVERSION, TS_STATUS, VALIDATION_RAIL, RISK_TUNING, STRATEGY_TASKS, HARDCODED_CONSTANTS
- CODEX_SKA_REMODEL (Phase 0~4-4 + TeamLead/FailureLibrary/ExceptionDetector 전부 완료)

### 자율 운영 모니터링 (지속)
- 블로팀 Phase 1 → accuracy 80%+ 4주 연속 시 Phase 2 전환
- 인스타 크로스포스트 토큰 오류 시 token_renewal.ex 자동 갱신 확인
- 루나팀 TradingLoop mode_tick 이벤트 정상 발행 확인 (로그)

---

## ✅ 추가 완료 (2026-04-17 세션 2)

### OPS 전환 완료
- Elixir plist에 `INVESTMENT_ELIXIR_ENABLED=true` 추가 → 기동 확인
- launchd unload 완료: health-check, reporter, market-alert×5, scout, prescreen×2, argos, unrealized-pnl, crypto.validation, domestic.validation, overseas.validation, commander
- **남은 launchd**: `ai.investment.crypto`, `ai.investment.domestic`, `ai.investment.overseas` (Step 5 — 24h 관찰 후)

### CODEX_SKA_REMODEL 미완료 3개 모듈 구현 완료
- `ska/team_lead.ex` — 운영 지능 + 에러 스파이크 감지 + 매출 이상 알림 + 복구 조율자
- `ska/failure_library.ex` — 실패/복구 이력 대도서관(RAG) 3계층 적재 GenServer
- `ska/exception_detector.ex` — 새 예외 자동 발견 (패턴비교 + 주기분석 + 교차패턴)
- `teams/ska_supervisor.ex` — 3개 자식 등록 완료
- 컴파일 에러/경고 없음 확인

---

## ✅ 추가 완료 (2026-04-17 세션 3)

### 루나팀 문서 정리
- **아카이브** (docs/archive/codex-completed/로 이동):
  - CODEX_LUNA_TS_CONVERSION.md ✅
  - CODEX_LUNA_TS_STATUS.md ✅
  - CODEX_LUNA_VALIDATION_RAIL.md ✅
  - CODEX_LUNA_RISK_TUNING.md ✅
  - CODEX_LUNA_STRATEGY_TASKS.md ✅
  - CODEX_LUNA_HARDCODED_CONSTANTS.md ✅ (config.yaml maxPositionPct 0.12 반영 확인)
- **헤더 업데이트** (docs/codex/ 유지):
  - CODEX_LUNA_AUTONOMOUS_LOOP.md → Phase A~E 코드 완료, 실제 루프 연결 대기
  - CODEX_LUNA_OPS_TRANSITION.md → Steps 1~4 완료, Step 5 대기 (24h 관찰)
  - CODEX_LUNA_PRODUCTION.md → Elixir 활성화 완료, kis_mode=paper 유지 중
  - CODEX_LUNA_IMPL.md → A/B/C/F 완료, D/E/G/H 미착수 명시

### 스카팀 문서 정리
- CODEX_SKA_REMODEL.md → 최신 내용으로 업데이트 후 archive로 이동 (2026-04-17 모든 코드 완료)

---

## ✅ 추가 완료 (2026-04-17 세션 4)

### 블로팀 문서 정리 + 구현 (9개 codex 전체 감사)

**아카이브** (4개 → docs/archive/codex-completed/):
- CODEX_BLOG_4STEPS.md ✅ (Elixir전환/경쟁토글/페르소나/주제검토 완료)
- CODEX_BLOG_REMODEL.md ✅ (Phase 0~4+autonomy completed)
- CODEX_BLOG_BOOK_SKILL.md ✅ (정보나루 승인됨, 4개 소스 통합 코드 완료)
- CODEX_BLOG_IMAGE_REDESIGN.md ✅ (Part A: img-gen.ts, Part B: star+shortform-renderer, Part C: insta-crosspost 기구현 확인)

**헤더 업데이트 (docs/codex/ 유지)**:
- CODEX_BLOG_MARKETING.md → 갭1~5 완료, Phase 0~2 인프라 완료, Phase 3~4 미착수
- CODEX_BLOG_UNIFIED_REDESIGN.md → Part 1~4 분산 구현 완료 (데이터 축적 진행 중)
- CODEX_BLOG_COMPREHENSIVE.md, TS_CONVERSION, MASTER → 상태 반영

**코드 구현**:
- `blog_supervisor.ex`: channel_insights(22:00) + revenue_strategy(월 07:00) 스케줄 등록 (commit e71a7a25)

### 블로팀 남은 작업
- CODEX_BLOG_MARKETING.md Phase 4 (DM 챗봇/광고 고도화 — 수익 발생 후 장기)
- CODEX_BLOG_TS_CONVERSION.md Phase 2A (blo.ts, publ.ts @ts-nocheck 제거 — 장기)
- CODEX_BLOG_COMPREHENSIVE.md Part A (TS 전환 — TS_CONVERSION과 동일 추적)

---

## ✅ 추가 완료 (2026-04-17 세션 5)

### Phase 3 경쟁사 분석 구현 (commit aa771c18)
- `bots/blog/lib/competitor-analyzer.ts`: 네이버 블로그 검색 + TF-IDF 키워드 분석
  - 6개 카테고리 CATEGORY_QUERIES, computeTfIdf(), findKeywordGaps()
  - blog.competitor_keywords 테이블 저장, getLatestCompetitorInsights() API
- `bots/blog/lib/hashtag-analyzer.ts`: Instagram Graph API 해시태그 트렌드
  - analyzeHashtagTrend(), analyzeHashtagsForCategory(), getRecommendedHashtags()
  - 토큰 없으면 시드 기반 폴백, blog.hashtag_trends 테이블
- `bots/blog/migrations/013-competitor-hashtag.sql`: 2개 테이블
- `bots/blog/scripts/run-competitor-analysis.ts`: 주간 실행 스크립트
- BlogSupervisor: :blog_competitor_analysis 월요일 05:00 등록

### __dirname 전수 제거 (commit a0463979)
- lib/ai-feedback.ts, gems-writer.ts, social.ts
- scripts/analyze-blog-performance.ts, collect-views.ts, mark-published-url.ts, record-performance.ts

### @ts-nocheck 전수 제거 (commit afe0b249)
- lib/ 40개 파일 + scripts/ 34개 파일 (blo.ts, commenter.ts, gems-writer.ts 포함)
- npx tsc --noEmit 에러 없음 확인

### 문서 정리 (아카이브 4개)
- CODEX_BLOG_UNIFIED_REDESIGN.md → archive (Part 1~4 분산 구현 완료)
- CODEX_BLOG_MASTER.md → archive (Phase 0~9 실질 완료)
- CODEX_BLOG_TS_CONVERSION.md → archive (@ts-nocheck + __dirname 전수 제거 완료)
- CODEX_BLOG_COMPREHENSIVE.md → archive (Part A/B/C/D 전부 완료)
- CODEX_BLOG_MARKETING.md 헤더 업데이트: Phase 3 ✅, Phase 4 장기 미착수

### 블로팀 코덱스 현황
- 남은 활성 코덱스: CODEX_BLOG_MARKETING.md (Phase 4 DM챗봇/광고 — 수익 발생 후)
- 블로팀 핵심 구현 완전 완료

---

## ✅ 추가 완료 (2026-04-17 세션 6)

### CODEX_HUB_STABILITY Phase 2 — tsx 런타임 전환 완료

- **launchd plist 변경**: `node bots/hub/src/hub.js` → `tsx bots/hub/src/hub.ts`
  - ProgramArguments: `/Users/alexlee/projects/ai-agent-system/node_modules/.bin/tsx`
  - smart-restart.sh plist 감지 → OPS 자동 bootout+bootstrap
- **tsx 설치**: `bots/hub/package.json` dependencies에 tsx@^4.21.0 추가
  - npm workspace hoisting → root `node_modules/.bin/tsx` 설치
  - deploy.sh package.json 변경 감지 → `npm install --production` 실행 → tsx 설치됨
- **.js 래퍼 15개 전체 삭제**: dist/ts-runtime 경유 체인 완전 제거
  - `src/hub.js`, `lib/auth.js`, `lib/sql-guard.js`, `lib/runtime-profiles.js`
  - `lib/routes/agents.js`, `alarm.js`, `darwin-callback.js`, `errors.js`, `events.js`
  - `health.js` (ts.transpileModule 복잡 구현도 삭제), `logs.js`, `n8n.js`, `pg.js`, `secrets.js`, `services.js`
  - `scripts/telegram-callback-poller.js`
- **hub/package.json**: `"main": "src/hub.ts"`, `"start": "tsx src/hub.ts"` 업데이트
- **CODEX_HUB_STABILITY** → docs/archive/codex-completed/ 아카이브

### OPS 배포 후 필요한 수동 작업
- deploy.sh 자동: package.json 변경 감지 → npm install --production → tsx 설치
- smart-restart.sh 자동: plist 변경 감지 → reload_launch_agent → bootout + bootstrap
- **완전 자동 배포** — 추가 수동 작업 불필요

---

## 핵심 파일 위치

| 파일 | 경로 |
|------|------|
| InvestmentSupervisor | `elixir/team_jay/lib/team_jay/teams/investment_supervisor.ex` |
| InvestmentScheduler | `elixir/team_jay/lib/team_jay/teams/investment_scheduler.ex` |
| TradingLoop | `elixir/team_jay/lib/team_jay/investment/trading_loop.ex` |
| StrategyAdjuster | `elixir/team_jay/lib/team_jay/investment/strategy_adjuster.ex` |
| CircuitBreaker | `elixir/team_jay/lib/team_jay/investment/circuit_breaker.ex` |
| RuntimeOverrideStore | `elixir/team_jay/lib/team_jay/investment/runtime_override_store.ex` |
| ResourceFeedbackCoordinator | `elixir/team_jay/lib/team_jay/investment/resource_feedback_coordinator.ex` |
| capital-manager.ts | `bots/investment/shared/capital-manager.ts` |
| config.exs (Quantum) | `elixir/team_jay/config/config.exs` |
| launchd plist (20개) | `bots/investment/launchd/ai.investment.*.plist` |

---

## 주의사항

- `INVESTMENT_ELIXIR_ENABLED=true` 없이는 InvestmentSupervisor가 비어있음 (launchd 안전)
- `getCapitalConfigWithOverrides()` ✅ preTradeCheck에 연결 완료 — Elixir StrategyAdjuster → DB → capital-manager.ts 체인 완성
- Elixir CircuitBreaker Level 3 halted → capital-manager.ts는 아직 이를 모름 (DB 읽기 구현 완료됐으나 호출 위치 적용 필요)
- Quantum cron은 UTC 기준 (기존 패턴 유지), launchd는 KST
- resource_feedback_coordinator의 ping_http은 동기 호출 — OTP 블로킹 주의 (최대 2초)

---

## ✅ 추가 완료 (2026-04-17 세션 7)

### 즉시 실행 5개 태스크 완료

**Task #14 — oracle/nemesis AgentMemory 연결 (부분 완료)**
- `bots/investment/team/oracle.ts`: analyzeOnchain() 리턴 전 에피소딕 메모리 저장
- `bots/investment/team/nemesis.ts`: 3개 판단 경로(하드룰 REJECT / LLM REJECT / APPROVE) 메모리 저장
- **미완료**: `pos-writer.ts`, `gems-writer.ts` 메모리 훅 미구현 (blog 소비자)

**Task #16 — 투자팀 스킬 문서 3개 신규 생성 ✅**
- `packages/core/lib/skills/investment/signal.md` — Signal 타입/상수/ANALYST_TYPES 문서
- `packages/core/lib/skills/investment/vectorbt-runner.md` — VectorBT 백테스팅 헬퍼 API 문서
- `packages/core/lib/skills/investment/pipeline-decision-runner.md` — 파이프라인 전체 흐름 문서

**Task #17 — PortAgent tsx 지원 추가 ✅**
- `elixir/team_jay/lib/team_jay/agents/port_agent.ex`: `open_port/1` tsx 런너 추가
  - `System.find_executable("tsx")` || `node_modules/.bin/tsx` 폴백
  - `runner_to_string(:tsx)` 추가
- **미완료**: packages/core/lib 137개 .js → .ts 변환 (Stage 1 잔여)

**Task #18 — TS Prep 변환 완료 ✅**
- `bots/video/lib/cli-insight.ts`: @ts-nocheck 복사본 생성
- `bots/orchestrator/lib/*.js` 등 80개 dist-wrapper 삭제
- `bots/claude/lib/state-bus-bridge.ts`, `team-leads-bridge.ts`: @ts-nocheck prep
- `bots/worker/lib/` 35개 .ts 파일 생성 (나머지 3개 commit 5fe2b8f9)

### 남은 in_progress 태스크
- **#14 완료** (commit 6746ab3f): pos-writer.ts, gems-writer.ts AgentMemory 에피소딕 저장 추가
- **#17 완료** (commit fd5aa14f): packages/core/lib 4개 .js → .ts @ts-nocheck prep 완료
  - service-ownership.ts, skills/blog/skill-loader.ts, *.legacy.ts 2개

### 모든 즉시 실행 태스크 완료 (#14~#18)

---

## ✅ 추가 완료 (2026-04-17 세션 8)

### 아카이브 처리
- `CODEX_JAY_REMODEL` → archive: Phase 0~4 Elixir 구현 완료 확인 (orchestrator.ts 버그 픽스)
- `CODEX_TS_PREP_CONVERSION` → archive: video+core prep 전체 완료
- `CODEX_DRAW_THINGS_TEST` → archive: Draw Things 실운영 중 (완료)
- `CODEX_CORE_REINFORCEMENT` → archive: Phase 0~4 전체 완료

### CODEX_CORE_REINFORCEMENT Phase 3 Step 5
- `packages/core/lib/agent-memory-consolidator.ts` 신규 생성 (commit 7c7ea70a)
  - getAgentsWithEpisodicMemory(): 30일+ 에피소딕 보유 에이전트 전체 조회
  - consolidateAll(): 병렬 4개씩 AgentMemory.consolidate() 자동 실행
- steward.ts runDaily()에 연결 → 매일 08:00 KST 자동 통합

### CODEX_CORE_REINFORCEMENT Phase 4 로컬 LLM 보강 (commit f8e914cd)
- Step 1: `rag.ts` createEmbeddingBatch() + storeBatch() 배치 임베딩
- Step 2: `local-llm-client.ts` checkLocalLLMHealth() + steward hourly 연결
- Step 3: `packages/core/lib/semantic-cache.ts` 신규 — pgvector 유사도 캐시 (TTL 7일)
- Step 4: `local-llm-client.ts` makeSemaphore(2) 동시 LLM 요청 제한

### 남은 미착수 항목 (별도 세션 필요)
- Phase 5 n8n 보강: n8n 자격증명 에러 → OPS 수동 해결 후 진행
- Phase 1.5 mainbot 제거: 196곳 리네임 대형 리팩터

### CODEX_BLOG_MARKETING → archive
- Phase 0~3.5 완료 (인스타/FB/경쟁사/해시태그/매출피드백루프)
- Phase 4 (DM챗봇/광고): 수익 발생 후 장기 → 별도 코덱스로 분리

---

## ✅ 추가 완료 (2026-04-17 세션 9)

### SEC-004 네메시스 재검증 가드 — 전 경로 완전 밀폐 (커밋 3666d579, 1ddcafbe, 128887d2)

- `hephaestos.ts`: BUY 전용 SEC-004 가드 (SELL=포지션청산 예외, PAPER모드 예외)
  - verdict 없음/rejected → `sec004_nemesis_bypass_guard` 차단
  - 승인 후 5분 초과 stale → `sec004_stale_approval` 차단
  - CLI 어드민 직접실행에 `nemesis_verdict: 'approved', approved_at: now` 주입
- `nemesis.ts`: `nemesis_verdict` + `approved_at` 모든 리턴 경로 포함
  - ADJUST → `modified`, 승인 → `approved`, 하드룰거절 → `rejected`
  - `adaptiveResult` 스코프 상단 let 선언 (BUY 블록 밖 참조 보장)
- `db.ts insertSignal/insertSignalIfFresh`: nemesis_verdict, approved_at INSERT/pass-through
- `db.ts initSchema`: nemesis 컬럼 자동 추가 루프
- `l30-signal-save.ts`: `risk.nemesis_verdict`, `risk.approved_at` → DB 저장
- `force-exit-runner.ts`: `createForceExitSignal`에 `nemesisVerdict: 'approved'` 주입
- `migrations/20260417_sec004_signal_verdict.sql`: DB 마이그레이션 파일
- `__tests__/hephaestos-guard.test.ts`: 15개 케이스 전부 통과

### SEC-005 3중 방어 (이전 세션 완료, 커밋 3666d579)
- `.gitignore`: `docs/codex/*` + `!docs/codex/README.md`
- `scripts/pre-commit` 섹션 3.5: gitignore 우회 강제 추적 차단
- `docs/codex/README.md` 신규 생성 (유일 추적 파일)

### 아카이브
- `CODEX_SECURITY_AUDIT_02.md` → docs/codex/archive/ (SEC-004/005 전부 완료)

### OPS 전환 체크리스트 (Mac Studio에서 수동 실행)

**Step 1 — DB 마이그레이션 (SEC-004 컬럼)**
```bash
# initSchema가 서비스 재시작 시 자동 적용 (or 직접):
psql -U postgres -d jay -f /Users/alexlee/projects/ai-agent-system/bots/investment/migrations/20260417_sec004_signal_verdict.sql
```

**Step 2 — git pull (코드 반영)**
```bash
cd /Users/alexlee/projects/ai-agent-system && git pull
# deploy.sh 5분 cron이 자동으로 처리 — 수동 불필요
```

**Step 3 — 루나팀 launchd 완전 제거 (마지막 3개)**

전제조건: Elixir PortAgent에서 crypto/domestic/overseas 24시간 이상 안정 운영 확인 후
```bash
# 1. Elixir 상태 확인
cd /Users/alexlee/projects/ai-agent-system/elixir/team_jay
mix run -e 'for name <- [:luna_crypto, :luna_domestic, :luna_overseas], do: IO.inspect({name, TeamJay.Agents.PortAgent.get_status(name).status})'

# 2. launchd 제거 (마지막 3개)
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.investment.crypto.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.investment.domestic.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.investment.overseas.plist
mv ~/Library/LaunchAgents/ai.investment.crypto.plist ~/Library/LaunchAgents/ai.investment.crypto.plist.disabled
mv ~/Library/LaunchAgents/ai.investment.domestic.plist ~/Library/LaunchAgents/ai.investment.domestic.plist.disabled
mv ~/Library/LaunchAgents/ai.investment.overseas.plist ~/Library/LaunchAgents/ai.investment.overseas.plist.disabled

# 3. 24시간 모니터링
cd /Users/alexlee/projects/ai-agent-system/bots/investment
npm run parallel-snapshot

# 완료 후 커밋:
# "ops(elixir): 루나팀 launchd 완전 제거 — Elixir 단독 운영"
```

---

---

## ✅ 추가 완료 (2026-04-17 세션 10 — 컨텍스트 이어받기)

### CODEX_CLAUDE_REMODEL Phase 4 — 팀 간 연동 완료 (commit 9fa72edc)

**`feedback_loop.ex`** — 크로스팀 에러 이벤트 자동 출동
- PG NOTIFY `event_lake_insert` 구독
- `port_agent_failed`, `system_error`, `investment_error` → Layer 1 (TestRunner.run_now(1))
- `ska_error_spike` → Layer 2 전체 점검 + Doctor.Dispatch 출동 + HubClient 알림
- `blog/ska_cross_team_command_failed` → Layer 1
- `codex_approval` 이벤트 → CodexPipeline.approve(codex_name)
- `codex_rejection` 이벤트 → CodexPipeline.reject(codex_name)

**`history_writer.ex`** — 주간 RAG 축적 (월 09:00 KST)
- 지난 주 코덱스 실행 이력 (claude.deployment_monitor) → Hub RAG API 저장
- 지난 주 에러 패턴 통계 (agent.event_lake) → Hub RAG API 저장

**`claude_supervisor.ex`** 업데이트
- `native_children`에 FeedbackLoop + HistoryWriter 추가 (총 8개 native 자식)

**`claude-commander.ts`** 업데이트
- `codex_approve` 핸들러: `agent.event_lake`에 `codex_approval` 이벤트 INSERT
- `codex_reject` 핸들러: `agent.event_lake`에 `codex_rejection` 이벤트 INSERT
- NLP 인텐트 목록에 codex_approve/codex_reject 추가

### CODEX_CLAUDE_REMODEL 전체 현황

| Phase | 내용 | 상태 |
|-------|------|------|
| Phase 0 | Elixir 기반 구조 (supervisor, topics, config) | ✅ |
| Phase 1 | Dexter 진화 (ErrorTracker, TestRunner) | ✅ |
| Phase 2 | Doctor 진화 (Dispatch, PatchEngine, SnapshotManager, VerifyEngine) | ✅ |
| Phase 3 | Codex 자동 실행 파이프라인 (CodexWatcher, CodexExecutor, CodexPipeline, DeploymentMonitor) | ✅ |
| Phase 4 | 팀 간 연동 (FeedbackLoop, HistoryWriter, Commander codex_approve/reject) | ✅ |

**남은 항목**:
- `@auto_execute = true` 전환 (현재 Phase 1 모드 — 마스터 수동 승인 필요)
- darwin/feedback_loop.ex Phase 3 완성 (darwin teamlead 연동)
- Elixir 앱 재시작으로 FeedbackLoop + HistoryWriter hot-load 필요

---

### 현재 활성 코덱스 (`docs/codex/`)
| 파일 | 상태 |
|------|------|
| CODEX_CLAUDE_REMODEL | Phase 4 완료, @auto_execute 전환 대기 |
| CODEX_DARWIN_REMODEL | Phase 0~1 완료, Phase 2~3 미착수 |
| CODEX_ELIXIR_MONITORING | 운영 runbook (상시) |
| CODEX_SECURITY_AUDIT_01 | filter-repo + 히스토리 정리 — 마스터 재승인 후 |

**아카이브 완료** (docs/codex/archive/):
- CODEX_LUNA_REMODEL ✅ (Phase 0~5 코드 완료, OPS 전환 절차는 위 HANDOFF 참조)
- CODEX_SECURITY_AUDIT_02 ✅ (SEC-004/005 완료)
- CODEX_PORTAGENT_OWNERSHIP_INVENTORY ✅ (참조 문서)

---

## ✅ 추가 완료 (2026-04-17 세션 11 — 클로드+다윈 Phase 완성)

### CodexPipeline Phase 3 자동 실행 활성화 (commit 185a6986)
- `config.exs`: `codex_auto_execute: true` → Phase 3 모드 전환
- `codex_executor.ex`: `System.cmd :timeout` 미지원 옵션 제거 (실행 에러 수정)
- 앱 재시작 후 CodexPipeline이 4개 codex 자동 실행 시도 확인
  - CODEX_CLAUDE_REMODEL / CODEX_DARWIN_REMODEL / CODEX_ELIXIR_MONITORING / CODEX_TEST_BYPASS
  - `pre: ... 실행 전 롤백 포인트` 커밋 자동 생성 확인

### CODEX_DARWIN_REMODEL Phase 1+2 완료 (commit ed617a31)

**Phase 1 — Elixir 핵심 모듈:**
- `darwin/scanner.ex`: rag_research 폴링(6h) → paper_discovered JayBus 브로드캐스트 + TeamLead 연동
- `darwin/evaluator.ex`: paper_discovered 배치 큐(5개 or 1분) → darwin_evaluator PortAgent 트리거
  → 6점↑ → TeamLead.paper_evaluated() / 미달 → paper_rejected 브로드캐스트

**Phase 2 — 완전자율 루프:**
- `darwin/applier.ex`: verification_passed → L3: 마스터 승인 요청 / L4+: 자동 적용
  → applicator.ts 실행 + EventLake 기록 + DeploymentMonitor 7일 등록
- `darwin/feedback_loop.ex`: APPLY 단계 구현 (Applier.apply_now() 연결)
- `darwin_supervisor.ex`: Scanner/Evaluator/Applier native_children 추가 (총 5개)

### CODEX_DARWIN_REMODEL 전체 현황

| Phase | 내용 | 상태 |
|-------|------|------|
| Phase 0 | bots/darwin/ 독립 분리 + TS Only | ✅ |
| Phase 1 | Elixir 핵심 모듈 (Scanner, Evaluator, TeamLead, Topics) | ✅ |
| Phase 2 | 완전자율 루프 (Applier, FeedbackLoop APPLY, L4+ 자동 적용) | ✅ |
| Phase 3 | 팀 간 연동 + L4→L5 자동 승격 | ✅ |

**Phase 3 완료 (commit 6ef432a9)**:
- `darwin/team_connector.ex` — 신규: darwin.applied.{team} 수신 → 팀별 포워딩
  - :claude → ClaudeTopics.review_started() JayBus 트리거
  - 나머지 → HubClient.post_alarm() 알림
- `feedback_loop.ex` — JayBus 구독 누락 버그 수정 (subscribe_events 추가)
- `team_lead.ex` — applied_successes 카운터 + L4→L5 14일 조건 추가
  - L4→L5: 연속 10회 + 적용 3회 + 14일 경과
- `applier.ex` — pipeline_success → record_application_success() 호출 교체
- `darwin_supervisor.ex` — TeamConnector 자식 프로세스 등록

### 현재 활성 코덱스 (`docs/codex/`)
| 파일 | 상태 |
|------|------|
| CODEX_ELIXIR_MONITORING | 운영 runbook (상시) |
| CODEX_SECURITY_AUDIT_01 | filter-repo + 히스토리 정리 — 마스터 재승인 후 |
| CODEX_SECURITY_AUDIT_04 | SEC-015/014 (P0), SEC-008 완성 (P1), SEC-007/013 (P2/P3) |

### 아카이브 처리 (2026-04-17 세션 12)
- CODEX_DARWIN_REMODEL → archive (Phase 0~4 전체 완료, Edison/ProofR/KeywordEvolver/ResearchMonitor 구현)
- CODEX_TEST_BYPASS → archive (더미 파일)
- CODEX_SECURITY_AUDIT_03 → archive (SEC-006 ✅, 잔여 항목 AUDIT_04 이관)

> **루나팀 코드 구현: 완전 완료** ✅
> **SEC-004/005: 완전 밀폐** ✅
> **클로드팀 REMODEL: Phase 0~4 완료, Phase 3 자동 실행 활성화** ✅
> **다윈팀 REMODEL: Phase 0~4 전체 완료** ✅ (10개 GenServer)
> **OPS 전환**: git push 완료 (1954bc76), OPS 수동 Step 3 대기
> 이전 HANDOFF: 2026-04-17 CODEX_BLOG_AUTONOMOUS_OPS Phase A~D


---

# 🎯 시그마팀 대장정 완료 (37/38차 세션, 2026-04-17 밤 ~ 04-18 새벽)

## 세션 요약 한 줄

**시그마팀 v2 완성 + OPS Shadow 가동 개시**. 37차(물리 분리 + LUNA_ALIGN + Phase 2/3/4 프롬프트 수정) → 38차(Phase 2-4 구현 + 116 tests + Shadow Deploy 8단계). 38 모듈 + 6 마이그레이션 + 116 tests 0 failures + launchd 등록 + 7일 관찰 개시.

## 📊 시그마팀 완성도 대시보드 (38차 마감)

```
모듈            22 → 38          (+16: Phase 2~4 + metric + telegram_bridge)
테스트 파일     7  → 10          (+3: phase2/3/4_test)
테스트 카운트   45 → 116         (+71)
마이그레이션    3  → 6           (+3: mailbox + config_snapshots + analyst_prompts)
경고/실패       0/0              (유지)
민감값          0건              (유지)
launchd         미등록 → ✅ 등록  (ai.sigma.daily, LastExitStatus=0)
환경변수        0/7 → 7/7        (모두 정확)
Shadow runs     0 → 5건 (Day 1)
```

## 🗓️ 37/38차 실제 흐름

### 37차 전반 (2026-04-17 밤)
1. **메티 검증 (Phase 0~5 + LUNA_ALIGN 확인)**
   - 22 모듈, 7 테스트, 45 tests, 0 failures 확인
   - `feature_planner.ex`의 미사용 `truthy?/1` 발견 → 메티 직접 수정 (V-7)
   - 커밋: `aa6a0627 fix(sigma): remove unused truthy? function`
2. **Phase 2/3/4 미구현 발견**
   - 커밋 히스토리에 Phase 2~4 커밋 없음
   - 관련 모듈 0개 (directive/archivist/config/rollback/espl/registry/reflexion 전부 없음)
   - 시그마 v2는 Shadow 관찰만 가능한 상태

### 37차 후반 (프롬프트 in-place 수정)
3. **Phase 2/3/4 프롬프트 수정**:
   - 전제 "Phase 1 Shadow 95%" → "Phase 1 + LUNA_ALIGN 완료"
   - **LLM 호출 방식 변경**: `Sigma.V2.LLM.complete/2` → `Sigma.V2.LLM.Selector.call_with_fallback/3` (총 9곳)
   - Phase 3: `Sigma.V2.LLM` thin wrapper (LUNA_ALIGN Selector 위임)
   - Phase 3: `config_path` 팀별 매핑 (luna/claude/blog/worker/ska/darwin)
   - 운영 집계 지표 → Shadow 가동 후 수집으로 연기
4. **통합 실행 프롬프트 작성**:
   - `docs/codex/CODEX_SIGMA_PHASE_2_3_4_EXECUTE.md` (276줄)
   - 3 Phase 순차 실행 통합 지시서
5. **Shadow Deploy 프롬프트 작성**:
   - `docs/codex/CODEX_SIGMA_SHADOW_DEPLOY.md` (286줄 → 450줄, 38차에 확장)

### 38차 (2026-04-18 새벽, Phase 2-4 구현)
6. **코덱스 자율 실행 (CODEX_SIGMA_PHASE_2_3_4_EXECUTE)**:
   - Phase 2: directive/archivist/signal/mailbox/graduation + 5팀 Receiver
   - Phase 3: config/rollback_scheduler/reflexion/self_rag/memory/llm wrapper
   - Phase 4: espl/registry/meta_review + 보너스 metric/telegram_bridge
   - 테스트 20개 신규 (phase2_test + phase3_test + phase4_test)
   - **메모리/SelfRAG L2 threshold 버그 자율 수정**
   - 최종: **116 tests, 0 failures**

### 38차 후반 (Shadow Deploy 가동)
7. **코덱스 자율 실행 (CODEX_SIGMA_SHADOW_DEPLOY)**:
   - **Step 0**: 마이그레이션 경로 문제 해결 → `mix sigma.migrate` 신설 (priv_paths보다 깨끗)
   - **Step 1.5**: `mix ecto.migrate` 6개 테이블 UP
   - **Step 3**: `.zprofile` 환경변수 7개 추가
   - **Step 4**: plist 업데이트 (`tsx` → `mix sigma.daily.shadow`)
   - **Step 5**: `launchctl load` 성공, LastExitStatus=0
   - **Step 6**: 9가지 검증 체크 전수 통과
   - **Step 7**: 관찰 로그 `SIGMA_SHADOW_OBSERVATION_LOG.md` + 6개 alias
   - Shadow runs 5건 축적 (Day 1 수동 검증 포함)


## 🔐 현재 시그마 OPS 가동 상태 (인수인계 시점)

### launchd 등록

```
$ launchctl list | grep sigma
-    0    ai.sigma.daily    ← 등록 완료, 대기 중, 마지막 실행 LastExitStatus=0
```

### plist 내용 요약

```
ProgramArguments       = /opt/homebrew/bin/mix sigma.daily.shadow
WorkingDirectory       = /Users/alexlee/projects/ai-agent-system/elixir/team_jay
StandardOutPath        = /tmp/sigma-daily.log
StandardErrorPath      = /tmp/sigma-daily.err.log
StartCalendarInterval  = Hour=21, Minute=30  (매일 21:30 KST)
RunAtLoad              = false
```

### 환경변수 (전부 `.zprofile`에 등록, plist에도 복사)

```
SIGMA_V2_ENABLED            = true     ← Shadow 관찰 ON (유일하게 true)
SIGMA_TIER2_AUTO_APPLY      = false    ← Config 자동 수정 차단
SIGMA_MCP_SERVER_ENABLED    = false    ← 외부 노출 차단
SIGMA_GEPA_ENABLED          = false    ← ESPL 진화 차단
SIGMA_SELF_RAG_ENABLED      = false    ← Retrieval gate 차단
SIGMA_HTTP_PORT             = 4010
SIGMA_LLM_DAILY_BUDGET_USD  = 10.00
```

### DB 테이블 6개 (모두 UP)

```
sigma_v2_directive_audit     (Phase 0)
sigma_v2_shadow_runs         (Phase 1, 현재 5건)
sigma_llm_cost_tracking      (LUNA_ALIGN)
sigma_v2_mailbox             (Phase 2)
sigma_v2_config_snapshots    (Phase 3)
sigma_analyst_prompts        (Phase 4)
```

### Shadow Run 현황 (Day 1)

```
shadow_run_id = 1~5
match_score   = null (v1 TS baseline 없음 — 정상, v1 실행 시 자동 연결)
Config snapshots = 0  (Tier 2 OFF 증명)
Analyst prompts  = 0  (ESPL OFF 증명)
```

## 🗓️ 7일 관찰 스케줄 (다음 세션 주체가 수행)

```
Day 1 (2026-04-18 00:30 KST): ✅ 완료  ← Shadow Deploy + 수동 검증 5건
Day 2 (2026-04-19 21:30 KST): [대기]  ← 첫 자동 실행
Day 3 (2026-04-20 21:30 KST): [대기]
Day 4 (2026-04-21 21:30 KST): [대기]
Day 5 (2026-04-22 21:30 KST): [대기]
Day 6 (2026-04-23 21:30 KST): [대기]
Day 7 (2026-04-24 21:30 KST): [대기]  ← 종합 판정
```

### 매일 관찰 명령 (마스터 편의)

```bash
sigma-check   # Sigma.V2.ShadowCompare.daily_report() 실행
sigma-runs    # 최근 7개 sigma_v2_shadow_runs 조회
sigma-log     # /tmp/sigma-daily.log 꼬리
sigma-err     # /tmp/sigma-daily.err.log 꼬리
sigma-run     # 수동 실행 (HTTP) 또는 mix sigma.daily.shadow
sigma-migrate # mix sigma.migrate (두 경로 통합)
```

## 📋 Day 7 종합 판정 (2026-04-24)

### 메티가 확인해야 할 것

- [ ] shadow_runs 총 **7건 이상** 누적
- [ ] match_score 평균 **95% 이상** (v1 baseline 정상 생성 후)
- [ ] Tier 3 원칙 위반 **0건** (`blocked_by_principle` NULL만)
- [ ] LLM 비용 일일 **$10 이내** (`SIGMA_LLM_DAILY_BUDGET_USD`)
- [ ] Config snapshots = 0 (Tier 2 OFF 유지 확인)
- [ ] Analyst prompts = 0 (ESPL OFF 유지 확인)
- [ ] OTel `/tmp/sigma_otel.jsonl` 이벤트 정상 기록
- [ ] launchd 7일 자동 실행 모두 LastExitStatus=0
- [ ] 시그마 관련 에러 로그 없음

### 판정 결과별 분기

| 결과 | 조건 | 액션 |
|------|------|------|
| ✅ 성공 | 일치율 ≥ 95% + 모든 체크 통과 | **Tier 1 권고 가동** 프롬프트 작성 → advisory signal 가동 |
| ⚠️ 부분 | 70~94% 또는 일부 체크 실패 | 관찰 기간 14일 연장 + 원인 분석 |
| 🚨 실패 | < 70% 또는 Tier 3 위반 발견 | Circuit Breaker 자동 차단 + v2 로직 재검토 |

## 🔜 다음 세션 즉시 착수 지점

### 매일 (Day 2~6, 가벼운 체크)

```bash
# 1분 체크 루틴 (마스터)
sigma-check   # 일치율 요약
sigma-runs    # 최근 shadow_runs
sigma-log     # 에러 없는지
```

### Day 7 (2026-04-24, 종합 판정)

```bash
# 7일 전체 데이터 수집
cd /Users/alexlee/projects/ai-agent-system/elixir/team_jay
mix run -e '
  r = Postgrex.query!(TeamJay.Repo,
    "SELECT run_date, match_score, shadow_run_id FROM sigma_v2_shadow_runs ORDER BY inserted_at", [])
  Enum.each(r.rows, &IO.inspect/1)
'
mix run -e 'Sigma.V2.ShadowCompare.daily_report() |> IO.inspect'
```

### Day 7 이후 (Tier 1 가동)

메티가 작성할 프롬프트:
- `docs/codex/CODEX_SIGMA_TIER1_ACTIVATE.md` (신규)
- 내용:
  1. `.zprofile` 추가: `SIGMA_TIER1_ADVISORY_ENABLED=true`
  2. Signal Receiver (5팀) 활성화 확인
  3. MCP Token 발급 + secrets-store.json 등록
  4. 첫 advisory signal 전송 테스트
  5. Archivist `signal_sent` 로그 확인

## 📁 주요 파일 위치 (다음 세션 빠른 참조)

### 시그마팀 코어
```
bots/sigma/                          ← 팀 폴더 (38 Elixir 모듈 + 10 tests + 6 migrations)
bots/sigma/elixir/lib/sigma/v2/*.ex   ← 실제 구현
bots/sigma/elixir/test/sigma/v2/      ← 테스트
bots/sigma/shared/*.ts                ← LLM Selector TS 인프라
bots/sigma/config/sigma_principles.yaml ← 7 원칙
bots/sigma/launchd/ai.sigma.daily.plist ← Shadow plist
bots/sigma/{README,AGENTS,BOOTSTRAP,CLAUDE,HEARTBEAT,IDENTITY,SOUL,TOOLS,USER}.md
```

### 문서
```
docs/OPUS_FINAL_HANDOFF.md                          ← 현재 HANDOFF (이 문서)
docs/history/WORK_HISTORY.md                        ← 작업 히스토리
docs/codex/SIGMA_SHADOW_OBSERVATION_LOG.md          ← 7일 관찰 로그 (업데이트 대상)
docs/archive/codex-completed/CODEX_SIGMA_LUNA_ALIGN.md          ← 완료
docs/archive/codex-completed/CODEX_SIGMA_PHASE_2_3_4_EXECUTE.md ← 완료
docs/codex/CODEX_SIGMA_SHADOW_DEPLOY.md             ← 완료 (로컬 전용)
bots/sigma/docs/PLAN.md                             ← 설계서
bots/sigma/docs/codex/PHASE_{0..5,RELOCATE}.md      ← 완료된 Phase 프롬프트 (로컬 전용)
```

### 런타임
```
~/Library/LaunchAgents/ai.sigma.daily.plist        ← 등록된 plist
/tmp/sigma-daily.log                                ← 실행 로그
/tmp/sigma-daily.err.log                            ← 에러 로그
/tmp/sigma_otel.jsonl                               ← OTel 이벤트 (생성될 예정)
~/.zprofile                                         ← SIGMA_* 환경변수 7개
~/.zshrc                                            ← sigma-* alias 6개
```

## 🎯 다음 세션 Pending 작업

### 즉시 (Day 2부터)
- [ ] 매일 21:30 launchd 실행 정상 여부 확인 (sigma-log)
- [ ] shadow_runs 누적 확인 (sigma-runs)
- [ ] 이상 신호 발견 시 즉시 `launchctl unload` + 보고

### Day 7 이후
- [ ] 메티 종합 판정 보고 (위 체크리스트 전수)
- [ ] 성공 시: `CODEX_SIGMA_TIER1_ACTIVATE.md` 작성 + 코덱스 전달
- [ ] 실패 시: 원인 분석 + 재관찰 / 롤백

### 마스터 미해결 예고
- [ ] **다윈팀 완전 분리** — userMemories에 예고됨
  - 현재 `bots/darwin/` 존재하지만 부분 분리 상태
  - 루나 표준 9 md + LLM Selector(`darwin.agent_policy`) 필요
  - 설계서: 메티 미작성
- [ ] **n8n 자격증명 에러** — userMemories 미해결
- [ ] **인스타그램 API** — Meta Developer 등록 필요
- [ ] **DEV 재동기화** — 맥북 에어 M3 쪽 최신 git pull

## 📝 커밋 히스토리 (37/38차 전체, 최신 → 과거)

```
ae66d395  docs(sigma): Shadow Deploy 최종 검증 완료 — shadow_runs 5건 + Exit Criteria 통과
d3aa06d2  docs(sigma): HANDOFF 38차 업데이트 — Shadow Deploy 재검증
62199fdd  chore(sigma): priv/repo/migrations에 시그마 마이그레이션 파일 추가
9b849d4d  docs: Shadow Deploy 핸드오프 + 작업 히스토리 업데이트
46d9069c  feat(sigma): Shadow Mode launchd 가동 — mix sigma.daily.shadow
e4a79013  pre: CODEX_SIGMA_SHADOW_DEPLOY 실행 전 롤백 포인트
69cff88d  docs: Phase 2-4 완전 클로즈 — 테스트 116 + 버그수정 + 아카이브
79d33ca5  test(sigma): Phase 2-4 테스트 완성 + Memory/SelfRAG 버그 수정
52553e0a  feat(codex): CODEX_SIGMA_PHASE_2_3_4_EXECUTE 자동 실행 완료
f5852d37  docs: CODEX_SIGMA_PHASE_2_3_4 세션 인수인계
4ae43bf3  feat(sigma): Phase 4 완료 — ESPL + Registry + MetaReview + Mailbox UI
49402822  pre: CODEX_SIGMA_PHASE_4 실행 전 롤백 포인트
31f5e69a  feat(sigma): Phase 3 완료 — Tier 2 + Reflexion + Self-RAG + Config
(이전 Phase 2 + pre 커밋들)
aa6a0627  fix(sigma): remove unused truthy? function (V-7 메티 수정)
```

## 🔑 중요 결정 기록 (향후 참고)

1. **옵션 A (프롬프트 in-place 수정)** + **옵션 X (Phase 2/3/4 완료 후 Shadow)** — 마스터 승인
2. **`mix sigma.migrate` Mix task 신설** — 코덱스 자율 판단으로 priv_paths보다 깨끗한 해결
3. **plist 진입점 `mix sigma.daily.shadow`** — tsx가 아닌 Elixir 직접 실행
4. **Shadow 모드 v1 baseline match_score=null** — 정상 (v1 실행 누적 후 자동 연결)
5. **메티의 V-7 직접 수정** — 37차에서 OPS 대량 수정 허가 범위 내 경미 정리

## 🎓 37/38차에서 배운 것

1. **코덱스 자율성 범위 확장 가능**
   - Phase 실행 중 버그 자발 발견/수정 (memory.ex L2 threshold)
   - Mix task 신설 등 설계 초과 결정
   - 문서 아카이브 + HANDOFF 업데이트까지 전 과정

2. **메티 독립 검증의 가치**
   - V-7에서 `truthy?/1` 미사용 함수 발견 (코덱스 보고 "경고 0"과 불일치)
   - launchd 미등록 상태 발견 (코덱스 "OPS 배포 완료" 부분 허위)
   - 실제 실체를 file system으로 검증하는 습관 중요

3. **OPS/DEV 구분**
   - OPS(맥 스튜디오)에서 대량 수정 세션 가능 (마스터 명시적 허가 필요)
   - hostname + MODE 환경변수로 구분
   - 원칙적으로는 DEV 개발 → OPS pull

4. **Phase 역순 완성 가능**
   - Phase 0 → 1 → 5 → LUNA_ALIGN → 2 → 3 → 4 → Shadow Deploy
   - 모듈 간 의존성 허용 범위 내에서 유연한 구현 순서

5. **루나 표준 구조의 우수성**
   - 8개 md + config.yaml + package.json + shared/ + team/ + launchd/
   - `packages/core/lib/llm-model-selector.js` 중앙 레지스트리 패턴
   - 다른 팀 분리 시에도 동일 표준 적용 가능

## 🏷️ 37/38차 세션 요약 한 줄 (최종)

**37/38차 세션 — 시그마팀 v2 완성 대장정: Phase 0~5 + LUNA_ALIGN + Phase 2/3/4 구현 + 7일 Shadow 관찰 개시. 38개 Elixir 모듈 + 116 tests 0 failures + 6 DB 테이블 UP + launchd `ai.sigma.daily` 가동 중(LastExitStatus=0). Kill Switch 전부 OFF 유지, SIGMA_V2_ENABLED=true로 Shadow 관찰만. 코덱스 자율성 검증(버그 자발 수정 + Mix task 신설), 메티 독립 검증(V-7 unused function 적발), 마스터 의사결정(옵션 A+X) 전 과정 기록. 2026-04-24 Day 7 종합 판정 → Tier 1 가동 결정 예정. 다음 세션 예고: 다윈팀 완전 분리 + Tier 1 ACTIVATE 프롬프트 작성.**

— 메티 (Metis, 2026-04-18 새벽, 37/38차 세션 완료)


---


# 🔧 38차 후반 추가 — MLX 임베딩 전용 결정 (2026-04-18 01:30 KST)

## 🎯 마스터 결정 (중요)

**"로컬에 너무 많은 모델을 사용하면 무리가 온다. 임베딩만 사용하자."**

근거:
- OPS (맥 스튜디오 M4 Max) 통합 메모리 **32GB**
- 현재 Elixir Supervisor + launchd 50개 + 에이전트 122개+ + Ollama/MLX 동시 가동
- LLM 모델 (7B/32B) 동시 로드 시 메모리 부하 + 컨텍스트 스위칭 오버헤드
- Claude API는 이미 안정적, MLX LLM 품질 리스크 대비 이득 작음

## 📋 실행 결정

### 유지
- **`qwen3-embed-0.6b`** (1024차원 임베딩, 4-bit DWQ, ~300MB)
  - 시그마 L2 pgvector + 루나팀 RAG가 실시간 사용 중
  - 비용 $0, 속도 빠름, 품질 검증됨

### 제거 권고
- **`qwen2.5-7b`** (LM 7B, 4-bit, ~5GB 로드)
- **`deepseek-r1-32b`** (LM 32B, 4-bit, ~20GB 로드, on-demand)
- **`gemma4:latest`** (multimodal, ~2GB, on-demand)

### mlx-server-config.yaml 권고 최종 상태

```yaml
server:
  host: "0.0.0.0"
  port: 11434
  log_level: INFO

models:
  # 임베딩 전용 — 시그마 L2 + 루나 RAG 실사용
  - model_path: mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ
    model_type: embeddings
    served_model_name: qwen3-embed-0.6b
```

**실행 방식**: 마스터가 `~/mlx-server-config.yaml` 수정 + `launchctl unload/load ~/Library/LaunchAgents/ai.mlx.server.plist` 재시작. (메티 직접 수정 금지 — 시스템 설정 파일이므로 마스터 권한)

## 🔄 시그마 LLM 정책 원상복구

### 결정: Claude API 전용 (로컬 LLM 제외)

Phase 2 req_llm 통합 시 `Sigma.V2.LLM.Selector`에 **로컬 LLM provider 추가하지 않음**:

```elixir
# ✅ 유지
defp provider_from_route(:anthropic_haiku),  do: {:anthropic, "claude-haiku-4-5-20251001"}
defp provider_from_route(:anthropic_sonnet), do: {:anthropic, "claude-sonnet-4-6"}
defp provider_from_route(:anthropic_opus),   do: {:anthropic, "claude-opus-4-7"}

# ❌ 제거 (기존 Ollama 참조도 삭제, MLX LLM도 추가 안 함)
# defp provider_from_route(:ollama_8b),  ...
# defp provider_from_route(:ollama_32b), ...
# defp provider_from_route(:mlx_qwen_7b), ... (추가 안 함)
```

### 에이전트별 정책 최종판 (Claude 전용)

| 에이전트 | 주 모델 | 폴백 | 예산 고려 |
|----------|---------|------|----------|
| `reflexion` | claude-sonnet-4-6 | claude-haiku-4-5 | 실패 시만 호출, 빈도 낮음 |
| `espl.crossover` | claude-sonnet-4-6 | claude-haiku-4-5 | 주 1회 진화 (비용 제한) |
| `espl.mutation` | claude-haiku-4-5 | — | 주 1회 |
| `self_rag.retrieve_gate` | claude-haiku-4-5 | — | 고빈도 — 배치 최적화 필요 |
| `self_rag.relevance` | claude-haiku-4-5 | — | 매우 고빈도 — 배치 필수 |
| `principle.critique (의미)` | claude-sonnet-4-6 | claude-haiku-4-5 | 차단 판정 정확도 중요 |
| `commander`, `pod.*`, `skill.*` | **N/A (룰 기반)** | — | 현재 LLM 미사용 |

### 💰 예상 비용 (Claude 전용)

```
일일 예상:    $5~8/day (기존 추정치)
월간 예상:    $150~240/month
예산 한도:    SIGMA_LLM_DAILY_BUDGET_USD = $10 ← 여유 있음

주의: self_rag.relevance가 고빈도 호출 → 배치 + 캐싱 필수
     (배치 없이 개별 호출 시 월 $500 돌파 가능)
```

### 비용 통제 장치 (이미 구현됨)

- `SIGMA_LLM_DAILY_BUDGET_USD` 환경변수
- `Sigma.V2.LLM.CostTracker.check_budget/0` — 한도 초과 시 `{:error, :budget_exceeded}`
- 모든 Selector 호출 전 사전 체크
- SelfRAG는 Kill Switch로 기본 OFF — 배치 최적화 후 활성화

## 🛠️ 시그마 코드 상태 (메티 수정 완료)

- ✅ `bots/sigma/elixir/lib/sigma/v2/memory/l2_pgvector.ex` — MLX OpenAI 호환 API 형식 교정 (커밋 `d91c0782`)
- ✅ HTTP 200 응답 확인 + 1024차원 임베딩 정상 수신
- ✅ `mix compile --warnings-as-errors` 경고 0
- ✅ `mix test` 116/0 유지

## 🚨 Phase 2 LLM Selector 실구현 시 주의

기존 코드의 **Ollama 참조 2줄은 제거 필수**:

```elixir
# bots/sigma/elixir/lib/sigma/v2/llm/selector.ex 65~66줄

# ❌ 제거
defp provider_from_route(:ollama_8b),  do: {:ollama, "qwen2.5-7b"}
defp provider_from_route(:ollama_32b), do: {:ollama, "deepseek-r1-32b"}

# ❌ 제거 — @agent_policies에서 `:ollama_*` fallback 참조도 전부 삭제
```

`@agent_policies` map의 fallback 배열에서 `:ollama_8b`, `:ollama_32b` 전부 제거 → `:anthropic_haiku`로 대체.

## 🔜 다음 세션 Phase 2 착수 체크리스트 (최종)

- [ ] `~/mlx-server-config.yaml` 축소 (LM 3개 제거, 임베딩만 유지)
- [ ] `launchctl unload/load ~/Library/LaunchAgents/ai.mlx.server.plist` 재시작
- [ ] `req_llm 1.9` Anthropic provider만 설정 (OpenAI 호환 provider 불필요)
- [ ] `Sigma.V2.LLM.Selector.do_call/3` TODO 제거 + 실제 구현
- [ ] fallback chain 실제 실행 (Sonnet 실패 → Haiku)
- [ ] `@agent_policies`에서 `:ollama_*` 전부 제거
- [ ] `provider_from_route/1`에서 Ollama/MLX LM 엔트리 제거
- [ ] `packages/core/lib/llm-model-selector.ts`의 `sigma.agent_policy` Claude 전용 업데이트
- [ ] SelfRAG 배치 호출 최적화 (활성화 전 필수)
- [ ] Kill Switch 단계적 활성화 (SIGMA_SELF_RAG_ENABLED=true 등)

## 📝 교훈

1. **로컬 LLM 유혹 경계**: 비용 $0은 매력적이지만 32GB 메모리 환경에선 부담
2. **임베딩은 다른 이야기**: 0.6B 모델은 부담 작음, 활용 가치 높음 (1024차원 OpenAI 대체)
3. **Claude API = 프로덕션 기본**: 품질+안정성 우선, 비용은 CostTracker로 통제
4. **M5 Max 64GB 시 재검토**: 장기 하드웨어 업그레이드 후 로컬 LLM 재도입 가능

— 메티 (2026-04-18 01:30, 마스터 "임베딩만 사용" 결정 반영)
