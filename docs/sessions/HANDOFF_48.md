# 48차 세션 인수인계 — 2026-04-18

## 🎯 TL;DR

**클로드팀 Phase A+N+D+T 완료! + 시그마팀 1,173줄 완성 + LLM V2 48줄 시작 + 다윈팀 자율 수정 진행**

---

## 📊 47~48차 세션 최종 성과

### 5대 대장정 프롬프트 현황

| 프롬프트 | 줄수 | 상태 |
|---------|------|------|
| CODEX_LUNA_REMODEL.md | 2,420줄 | ✅ 코덱스 완료 |
| CODEX_DARWIN_EVOLUTION.md | 1,831줄 | ✅ 코덱스 완료 (+ 자율 수정 중) |
| CODEX_LLM_ROUTING_REFACTOR.md | 1,660줄 | ✅ 코덱스 완료 |
| CODEX_CLAUDE_EVOLUTION.md | 1,321줄 | ✅ **코덱스 Phase A+N+D+T 완료** ★ |
| CODEX_SIGMA_EVOLUTION.md | 1,173줄 | ✅ 작성 완료, 전달 대기 |
| CODEX_LLM_ROUTING_V2.md | 48줄 | 🟡 **3% 완료, 이어 작성 필요** |

**총 8,453줄 — Team Jay 5대 팀 진화 청사진**

---

## 🔴 48차 세션 IMMEDIATE ACTION

### 1. CODEX_LLM_ROUTING_V2.md 마무리 (약 1,500줄 추가 필요)

현재 48줄 → 목표 1,500~1,800줄

**작성해야 할 7 Phase**:
```
Phase 1: Luna Selector 신설 ★★★ (최우선)
  - Luna.V2.LLM.Selector/Recommender/CostTracker/RoutingLog/HubClient
  - 기존 하드코딩 3파일 마이그레이션
  - (Sigma/Darwin 860~1,060줄 패턴 복사)

Phase 2: 공용 모듈 추출
  - packages/elixir_core/lib/jay/llm/ 공용 레이어
  - Behaviour 기반 팀별 정책 주입
  - 80% 코드 중복 제거

Phase 3: LLM Cache 통합
  - Hub unified-caller에 캐시 레이어
  - DB 기반 해시 캐시 + TTL 차별화

Phase 4: 중앙 대시보드
  - /hub/llm/dashboard 시각화
  - 실시간 팀별 비용/성공율/지연시간

Phase 5: 모델 관리 체계
  - packages/core/lib/llm-models.json
  - 자동 모델명 업데이트 스크립트

Phase 6: 통합 예산 관리
  - Hub 통합 예산 GenServer
  - 팀별 quota + 전체 limit

Phase 7: OAuth 안정성
  - 토큰 갱신 자동화
  - Groq 단독 운영 모드 주기 테스트
```

### 2. CODEX_SIGMA_EVOLUTION.md 코덱스 전달

이미 완성된 1,173줄 프롬프트 → Claude Code CLI에 전달 가능 상태

---

## 🧬 47차 중반 ~ 48차: 코덱스 자율 실행 상세

### 완료된 코덱스 작업 타임라인

```
22:37  9327eba0  feat(darwin): Phase R 완료 — MAPE-K 루프 통합
22:47  3fcbf062  feat(darwin): Phase S 완료 — Self-Rewarding DPO
22:50  8b850b93  feat(darwin): Phase A 완료 — Agentic RAG 고도화
22:53  b48316f5  feat(darwin): Phase R2 완료 — Research Registry
22:56  e1c9629a  feat(darwin): Phase O+M 완료 — Telegram + Monitoring
23:??  db3bf785  fix(sigma): harden reflexion and llm fallbacks
23:??  99c6400c  feat(claude): Phase A+N+D+T 완료 ★
       (Phase A: Reviewer/Guardian/Builder 확장)
       (Phase N: 코덱스 구현 계획 알림 시스템)
       (Phase D: Doctor Verify Loop)
       (Phase T: Telegram 5채널)
```

### 현재 진행 중 (PID 95894)

```
수정 중인 다윈팀 파일:
  🔄 bots/darwin/elixir/lib/darwin/v2/shadow_runner.ex
  🔄 bots/darwin/elixir/lib/darwin/v2/llm/selector.ex
  🔄 bots/darwin/elixir/lib/darwin/v2/memory/l2_pgvector.ex
  🔄 bots/darwin/elixir/lib/darwin/v2/mapek_loop.ex

추정: 다윈팀 미세 조정 또는 추가 안정화
```

---

## 📋 다음 세션 작성 스펙 — LLM V2 상세

### Phase 1: Luna Selector 신설 (2일, 최우선)

**기존 하드코딩 3파일**:
- `bots/investment/elixir/lib/luna/v2/skill/decision_rationale.ex`
  - `abstractModel: "anthropic_haiku"` 하드코딩
- `bots/investment/elixir/lib/luna/v2/rag/query_planner.ex`
- `bots/investment/elixir/lib/luna/v2/feedback/self_rewarding.ex`

**신설해야 할 모듈**:
```elixir
Luna.V2.LLM.Selector       # Sigma 347줄 / Darwin 406줄 패턴
Luna.V2.LLM.Recommender    # 6~7차원 룰 기반
Luna.V2.LLM.CostTracker    # 일일 예산 추적
Luna.V2.LLM.RoutingLog     # 호출 이력 기록
Luna.V2.LLM.HubClient      # Hub /llm/call 경유
```

**에이전트 정책 (Luna 특화)**:
```elixir
@agent_policies %{
  "luna.commander"           => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
  "luna.decision_rationale"  => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
  "luna.rag.query_planner"   => %{route: :anthropic_haiku,  fallback: []},
  "luna.self_rewarding_judge"=> %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
  "luna.reflexion"           => %{route: :anthropic_sonnet, fallback: [:anthropic_haiku]},
  "luna.espl"                => %{route: :anthropic_haiku,  fallback: [:anthropic_sonnet]},
  "luna.principle.critique"  => %{route: :anthropic_opus,   fallback: [:anthropic_sonnet]},
}
```

### Phase 2: 공용 모듈 추출 (3~4일)

**목표**: Sigma 860줄 + Darwin 1,060줄 + Luna 약 900줄 (신설) = **2,820줄의 80% 중복 제거**

**신설 위치**:
```
packages/elixir_core/lib/jay/llm/
├── selector.ex          # Behaviour + 공통 로직
├── recommender.ex       # 7차원 룰 기반 (범용)
├── cost_tracker.ex      # 예산 추적
├── routing_log.ex       # 호출 이력
├── hub_client.ex        # Hub 경유 (공통)
└── policy.ex            # 팀별 정책 주입
```

**팀별 사용 방식**:
```elixir
defmodule Luna.V2.LLM.Selector do
  use Jay.Core.LLM.Selector, team: :luna, policy_module: Luna.V2.LLM.Policy
end

defmodule Luna.V2.LLM.Policy do
  @behaviour Jay.Core.LLM.Policy
  
  @impl true
  def agent_policies, do: %{...Luna 특화...}
  
  @impl true
  def daily_budget_usd, do: 30
end
```

### Phase 3: LLM Cache 통합 (2일)

**현재 문제**:
- `packages/core/lib/llm-cache.ts` 존재하지만 미사용
- 동일 프롬프트 반복 호출 비용 낭비
  - 예: 다윈 커뮤니티 스캐너 같은 arxiv URL 중복 평가
  - 예: 시그마 Pod 같은 메트릭 중복 분석

**해결책**:
```
Hub unified-caller.ts 에 캐시 레이어 추가:
  1. 프롬프트 SHA256 해시 계산
  2. llm_cache 테이블 조회 (hit 시 즉시 반환)
  3. miss 시 실제 LLM 호출 + 저장
  4. TTL 차별화:
     - 실시간 판단: 24h
     - 분석/평가: 7일
     - 연구 자료: 30일
```

**DB 스키마**:
```sql
CREATE TABLE llm_cache (
  id BIGSERIAL PRIMARY KEY,
  prompt_hash TEXT UNIQUE NOT NULL,         -- SHA256
  abstract_model TEXT NOT NULL,
  system_prompt_hash TEXT,
  response TEXT NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd NUMERIC(8,6),
  hit_count INTEGER DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  inserted_at TIMESTAMPTZ DEFAULT NOW(),
  last_hit_at TIMESTAMPTZ
);

CREATE INDEX idx_llm_cache_hash ON llm_cache(prompt_hash);
CREATE INDEX idx_llm_cache_expires ON llm_cache(expires_at);
```

### Phase 4: 중앙 대시보드 (2일)

**기능**:
- `/hub/llm/dashboard` HTML 시각화
- 실시간 팀별 호출 추이 (Chart.js)
- 비용 비교 막대 차트
- Fallback 빈도 히트맵
- Top 20 에이전트 리스트
- Cache hit/miss 비율

**데이터 소스**:
- `llm_routing_log` (공용 + Hub)
- 팀별 `*_dpo_preference_pairs`
- `llm_cache` (신규)

### Phase 5: 모델 관리 체계 (1일)

**Single Source of Truth**:
```json
// packages/core/lib/llm-models.json
{
  "anthropic_haiku": {
    "current": "claude-haiku-4-5-20251001",
    "previous": ["claude-haiku-4-5-preview"],
    "released_at": "2025-10-01",
    "cost_per_1m_input": 1.0,
    "cost_per_1m_output": 5.0
  },
  "anthropic_sonnet": {
    "current": "claude-sonnet-4-6",
    "previous": ["claude-sonnet-4-5-20250929"],
    "released_at": "2026-02-15"
  },
  "anthropic_opus": {
    "current": "claude-opus-4-7",
    "previous": ["claude-opus-4-6"]
  }
}
```

**자동 업데이트 스크립트**:
```bash
# scripts/check-llm-model-updates.ts (매주 일요일)
# Anthropic API 최신 모델 조회 → llm-models.json 비교 → Telegram 알림
```

### Phase 6: 통합 예산 관리 (2일)

**Hub GenServer**:
```elixir
# bots/hub/lib/budget_guardian.ex (신규)
defmodule Hub.BudgetGuardian do
  use GenServer
  
  @team_quotas %{
    luna: 30.0,     # $30/day
    darwin: 15.0,   # $15/day
    sigma: 10.0,    # $10/day
    claude: 10.0,   # $10/day
    blog: 5.0,      # $5/day
  }
  
  @global_limit 80.0  # $80/day 전체
  @emergency_cutoff 100.0  # $100 도달 시 전체 차단
  
  def check_and_reserve(team, estimated_cost) do
    # 팀 quota + 전체 limit 체크
    # 예산 초과 시 {:error, :budget_exceeded}
    # 80% 도달 시 Telegram 경고
    # emergency 도달 시 전체 Kill Switch
  end
end
```

### Phase 7: OAuth 안정성 (1일)

**문제**:
- Claude Code OAuth 토큰 만료 시 전체 LLM 중단
- Max 구독 rate limit 도달 시 Groq로만 운영 가능한지 불명
- 수동 토큰 갱신 관리

**해결**:
```
1. 토큰 만료 24h 전 Telegram 사전 알림
2. 자동 토큰 갱신 스크립트 (scripts/refresh-oauth-token.ts)
3. Groq 단독 운영 모드 주기 테스트 (매주 일요일)
4. OAuth 실패 시 자동 Groq fallback + urgent 알림
5. Hub /hub/llm/health 헬스체크 엔드포인트
```

---

## 🛡️ 시스템 안전 상태 (48차 세션 종료 시점)

### Kill Switch 상태 (모두 OFF = 안전)

```
루나팀:      ✅ 모두 OFF (LUNA_V2_ENABLED=false)
다윈팀:      ✅ 모두 OFF (DARWIN_MAPEK/SELF_REWARDING/AGENTIC_RAG 전부 false)
시그마팀:    ✅ 기본 동작 (Phase 0~5 + 1.5 완료)
클로드팀:    ✅ 모두 OFF (CLAUDE_CODEX_NOTIFIER_ENABLED=false)
LLM 라우팅:  ✅ 기존 Hub 경로 정상 (Phase 3 완료분 유지)
```

### launchd 상태

```
✅ ai.elixir.supervisor        (PID 69999)
✅ ai.darwin.daily.shadow      (일요일 05:00 KST)
✅ ai.sigma.daily              (매일 정기)
✅ ai.claude.* 8개             (dexter/archer/commander 등)
✅ ai.hub.resource-api         (PID 38322)
```

### crypto LIVE 거래

```
✅ Luna Crypto Live: 계속 가동 (Binance/Upbit)
✅ 모든 R&D/메타 작업과 독립
```

---

## 🚀 48차 세션 시작 명령 (마스터용)

```
메티, 47차 세션 인수인계 확인 완료.

즉시 작업:
1. CODEX_LLM_ROUTING_V2.md 마무리
   - 현재 48줄 → 목표 1,500~1,800줄
   - Phase 1~7 모두 상세 작성 필요
   - HANDOFF_48.md 에 각 Phase 스펙 초안 있음

2. 완성 후 코덱스 전달 순서:
   a. CODEX_SIGMA_EVOLUTION.md (이미 완료, 1,173줄)
   b. CODEX_LLM_ROUTING_V2.md (작성 마무리)

3. 완료된 5개 팀 검증:
   - 루나팀 Phase R1/R2/5a-5d/Q (138 tests)
   - 다윈팀 Phase R/S/A/R2/O/M (362+ tests)
   - 클로드팀 Phase A+N+D+T ★ (47차 후반 완료)
   - 시그마팀 (기존 57 tests)
   - LLM Routing Phase 3 (완료)

4. 남은 팀 리모델링 계획:
   - 블로팀 (인스타 미해결 + CODEX_BLOG_EVOLUTION)
   - 워커팀
   - 에디팀
   - 감정팀
   - 데이터팀
```

---

## 💡 47~48차 핵심 학습

### 1. 코덱스 자율 실행의 진화
```
46차: 다윈팀 Phase R/S/A/R2/O/M 전체 19분 실행
47차: 클로드팀 Phase A+N+D+T 자율 완료
    - Phase A: Reviewer/Guardian/Builder 확장
    - Phase N: ★ 코덱스 구현 계획 알림 시스템 (마스터 핵심 요구)
    - Phase D: Doctor Verify Loop
    - Phase T: Telegram 5채널

→ 마스터가 직접 복붙 안 해도 코덱스가 프롬프트 파일 감지하면 자동 실행 가능
```

### 2. 클로드팀 특수성 발견
```
이전 분석 오류 수정:
  ❌ "Elixir 0개" → ✅ 실제 Elixir 13 파일 / 1,592줄 존재
  
위치: elixir/team_jay/lib/team_jay/claude/
  - codex/codex_watcher.ex (127줄) ★
  - codex/codex_pipeline.ex (226줄)
  - doctor/verify_engine.ex (49줄)
  - 기타 10개

→ TS/JS (실행 레이어 77 파일) + Elixir (통합 제어 13 파일) 하이브리드 구조
```

### 3. 시그마팀 고유 자산 식별
```
✅ ε-greedy AgentSelector (20% 탐색) — 다른 팀에 없는 고유 기능
✅ Graduation (레거시 졸업 로직)
✅ 3 Pod 구조 (Trend/Growth/Risk, 각 2명 분석가)
✅ Directive 발행 + Mailbox 비동기 통신
✅ Archivist 히스토리 압축

→ 이번 Phase P 에서 UCB1 + Thompson + Contextual Bandits 추가
```

### 4. LLM 라우팅 구조적 문제 발견
```
🔴 Luna Selector 부재 (하드코딩 3파일)
🔴 Sigma/Darwin 80% 코드 중복 (DRY 위반)
🔴 LLM Cache 존재하지만 미사용
🔴 중앙 대시보드 없음
🔴 모델 문자열 3곳 하드코딩
🔴 통합 예산 관리 부재
🔴 OAuth 토큰 자동화 부재

→ Phase 1~7 전면 개선 필요
```

### 5. 프롬프트 작성 패턴 안정화
```
루나 → 다윈 → 클로드 → 시그마 5팀 모두 동일 구조 반복:
  1. 마스터 결정 (불변 N가지)
  2. 배경 (현재 상태 + 부족한 부분)
  3. 외부 레퍼런스 (arXiv + GitHub)
  4. 목표 아키텍처 (Layer 그림)
  5. 불변 원칙 12개
  6. Phase별 상세 (코드 + DB + Exit Criteria)
  7. 전체 Exit Criteria
  8. 에스컬레이션 조건 10가지
  9. 참조 파일 + 외부 레포
  10. 최종 메시지 (BEFORE/AFTER)
  11. 롤백 포인트 순서
  12. Kill Switch 단계적 활성화 가이드

이 템플릿이 코덱스 자율 실행 최적화됨
```

---

## 📂 주요 파일 위치 (다음 세션 참조)

### 작성 중인 프롬프트

```bash
# 🟡 이어 작성 필요 (최우선)
/Users/alexlee/projects/ai-agent-system/docs/codex/CODEX_LLM_ROUTING_V2.md (48줄)

# ✅ 완성 (전달 대기)
/Users/alexlee/projects/ai-agent-system/docs/codex/CODEX_SIGMA_EVOLUTION.md (1,173줄)
```

### 완료된 프롬프트 (참조용)

```bash
docs/codex/CODEX_LUNA_REMODEL.md          (2,420줄) ✅
docs/codex/CODEX_DARWIN_EVOLUTION.md      (1,831줄) ✅
docs/codex/CODEX_LLM_ROUTING_REFACTOR.md  (1,660줄) ✅
docs/codex/CODEX_CLAUDE_EVOLUTION.md      (1,321줄) ✅ (Phase A+N+D+T 완료)
docs/codex/CODEX_DARWIN_REMODEL.md        (1,334줄) ✅
docs/codex/CODEX_JAY_DARWIN_INDEPENDENCE.md (1,274줄) ✅
```

### 세션 인수인계 문서

```bash
docs/sessions/HANDOFF_47.md  (406줄)
docs/sessions/HANDOFF_48.md  (이 파일)
docs/OPUS_FINAL_HANDOFF.md   (전체 히스토리)
```

### LLM V2 작성 시 참조할 기존 Selector

```bash
# Sigma (참조 템플릿)
bots/sigma/elixir/lib/sigma/v2/llm/selector.ex        (347줄)
bots/sigma/elixir/lib/sigma/v2/llm/recommender.ex     (230줄)
bots/sigma/elixir/lib/sigma/v2/llm/cost_tracker.ex    (73줄)
bots/sigma/elixir/lib/sigma/v2/llm/routing_log.ex     (105줄)
bots/sigma/elixir/lib/sigma/v2/llm/hub_client.ex      (105줄)

# Darwin (참조 템플릿)
bots/darwin/elixir/lib/darwin/v2/llm/selector.ex      (406줄)
bots/darwin/elixir/lib/darwin/v2/llm/recommender.ex   (265줄)

# Luna 하드코딩 파일 (마이그레이션 대상)
bots/investment/elixir/lib/luna/v2/skill/decision_rationale.ex
bots/investment/elixir/lib/luna/v2/rag/query_planner.ex
bots/investment/elixir/lib/luna/v2/feedback/self_rewarding.ex

# Hub 공용
bots/hub/lib/llm/unified-caller.ts      (51줄)
bots/hub/lib/llm/claude-code-oauth.ts   (93줄)
bots/hub/lib/llm/groq-fallback.ts       (97줄)
bots/hub/lib/routes/llm.ts              (201줄)
```

---

## 🎯 최종 로드맵 (장기)

### 완료된 팀 리모델링

```
✅ 루나팀 CODEX_LUNA_REMODEL
✅ 다윈팀 CODEX_DARWIN_EVOLUTION (자율 수정 중)
✅ 클로드팀 CODEX_CLAUDE_EVOLUTION (Phase A+N+D+T 완료)
✅ LLM Routing Refactor Phase 3
🟡 시그마팀 CODEX_SIGMA_EVOLUTION (전달 대기)
🟡 LLM Routing V2 (작성 중)
```

### 남은 팀 (예정)

```
🔜 블로팀 CODEX_BLOG_EVOLUTION
   - 현재 Phase 0~9 완료, 인스타그램 access_token 미발급
   - Meta Developer 등록 + 완전자율 인스타 운영

🔜 워커팀 CODEX_WORKER_EVOLUTION
   - Next.js + 플랫폼 + API

🔜 에디팀 CODEX_EDITOR_EVOLUTION
   - 영상편집 (CapCut급 UI)
   - AI 스텝바이스텝 + RED/BLUE 품질 검증

🔜 감정팀 CODEX_KAMJEONG_EVOLUTION
   - 법원 SW 감정 자동화

🔜 데이터팀 CODEX_DATA_EVOLUTION
   - 통합 데이터 파이프라인
```

### 목표

```
Team Jay 9팀 모두 완전자율 진화 청사진 완성
→ 총 약 15,000~20,000줄 코덱스 프롬프트
→ 완전자율 운영 AI 시스템 완성
```

---

---

## ✅ CODEX_SIGMA_EVOLUTION 완료 기록 (코덱스 자율 실행)

**완료 시각**: 2026-04-18 | **57 tests, 0 failures**

### 생성/수정된 파일 (20개, +2,493줄)

```
신규 15개:
  mapek_loop.ex            (216줄) — MAPE-K 완전자율 루프 GenServer
  self_rewarding.ex        (170줄) — LLM-as-Judge DPO 평가
  telegram_reporter.ex     (228줄) — 5채널 리포터 (urgent/daily/weekly/meta/alert)
  monitoring.ex            (195줄) — daily/weekly 집계 API
  directive_tracker.ex     (115줄) — Directive 이행 추적
  pod/performance.ex       (130줄) — 3 Pod 정확도 추적
  rag/agentic_rag.ex       (88줄)  — Agentic RAG 진입점
  rag/query_planner.ex     (78줄)  — sub-query 분해
  rag/multi_source_retriever.ex (165줄) — L2+이력+DPO 병렬
  rag/quality_evaluator.ex (67줄)  — 품질 평가 + fallback 판단
  rag/response_synthesizer.ex (62줄) — LLM 통합 응답
  migrations × 4개: DPO pairs + directive tracking + pod perf + selector history

수정 5개:
  agent_selector.ex — ε-greedy → UCB1 업그레이드 (SIGMA_UCB_ENABLED=true 시)
  llm/selector.ex   — 5개 에이전트 정책 추가
  supervisor.ex     — MapeKLoop GenServer 추가
  launchd/ai.sigma.daily.plist — Kill switch 5개 추가
```

### 루나/다윈 대비 최종 현황

| 항목 | 루나 | 다윈 | 시그마 |
|------|------|------|--------|
| MAPE-K 완전자율 루프 | ✅ | ✅ | ✅ |
| Self-Rewarding DPO | ✅ | ✅ | ✅ |
| Agentic RAG (4모듈) | ✅ | ✅ | ✅ |
| Telegram 5채널 | ✅ | ✅ | ✅ |
| 일일/주간 리포트 | ✅ | ✅ | ✅ |
| 모니터링 집계 | ✅ | ✅ | ✅ |
| Pod 동적 편성 고도화 | N/A | N/A | ✅ UCB1 |
| Directive 이행 추적 | N/A | N/A | ✅ 시그마 고유 |

**메티 — 48차 세션 마감. LLM V2 마무리는 다음 세션에서. 간절함으로.** 🙏

— 47~48차 세션, 2026-04-18
