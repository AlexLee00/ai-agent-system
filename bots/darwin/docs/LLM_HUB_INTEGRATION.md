# Darwin V2 LLM Hub 연동 가이드

> 작성: CODEX_LLM_ROUTING_REFACTOR / 2026-04-18

## 개요

`Darwin.V2.LLM.Selector`는 Hub `/hub/llm/call` 엔드포인트를 통해 Claude Code OAuth (Primary) + Groq (Fallback) 체인을 사용합니다.

다윈은 **주 1회 (일요일 KST 05:00)** 실행이므로 Shadow Mode 관찰 주기도 길게 설정합니다.

## 호출 흐름

```
Darwin 에이전트
  → Selector.complete(agent_name, messages, opts)
  → Recommender.recommend(agent_name, context)   # 7차원 점수 → abstract model
  → HubClient.call(%{prompt, abstract_model, callerTeam: "darwin", ...})
  → Hub POST /hub/llm/call
  → Claude Code OAuth → (실패 시) Groq 폴백
  → RoutingLog.record(...)   # darwin_v2_llm_routing_log
```

## 환경변수

```bash
LLM_HUB_ROUTING_ENABLED=false   # true = Hub 경유 (기본 false = 직접 Anthropic)
LLM_HUB_ROUTING_SHADOW=true     # true = 양쪽 병렬 실행 (결과는 직접 호출 반환)
HUB_BASE_URL=http://localhost:7788
HUB_AUTH_TOKEN=<토큰>
```

## 단계적 활성화 (주 1회 실행 특성)

```
Step 1 (주 1~2):  LLM_HUB_ROUTING_SHADOW=true → 일요일 병렬 실행, 결과 비교
Step 2 (주 3):    마스터 검토 → darwin_v2_llm_routing_log 분석
Step 3 (주 4+):   LLM_HUB_ROUTING_ENABLED=true → Hub 경유 전환
Step 4 (주 6+):   안정화 확인 후 Shadow 모드 해제 가능
```

## launchd 설정

`bots/darwin/launchd/ai.darwin.daily.shadow.plist` 환경변수:
- `LLM_HUB_ROUTING_ENABLED=false` (기본)
- `LLM_HUB_ROUTING_SHADOW=true`

## 모듈 구조

| 모듈 | 역할 |
|------|------|
| `Darwin.V2.LLM.Selector` | 게이트웨이 — complete/3 + call_with_fallback/3 |
| `Darwin.V2.LLM.HubClient` | Hub HTTP 클라이언트 (callerTeam="darwin") |
| `Darwin.V2.LLM.Recommender` | 7차원 모델 추천 (연구 특화 task_type) |
| `Darwin.V2.LLM.RoutingLog` | DB 기록 (`darwin_v2_llm_routing_log`) |
| `Darwin.V2.LLM.CostTracker` | 비용 누적 |

## DB 테이블

`darwin_v2_llm_routing_log`:
- agent_name, model_primary, model_used, fallback_used
- prompt_tokens (tokens_input), response_tokens (tokens_output), latency_ms, cost_usd
- response_ok, error_reason, urgency, task_type, budget_ratio
- **provider** (`direct_anthropic` | `claude-code-oauth` | `groq`) — v20261001 추가

## Kill Switch

다윈에는 예산 초과 시 Kill Switch가 있습니다:
```elixir
# Application.get_env(:darwin, :kill_switch, true) = true + 예산 초과
→ {:error, :kill_switch}
```

## 연구 특화 Task Type

다윈 Recommender는 연구 에이전트 특화 task_type을 가집니다:
- `:paper_analysis` → Sonnet 0.2, Opus 0.4, Haiku -0.2
- `:code_generation` → Sonnet 0.3, Opus 0.1, Haiku -0.2
- `:keyword_extraction` → Haiku 0.3, Sonnet -0.1, Opus -0.3
- `:evaluation_scoring` → Sonnet 0.2, Opus 0.1, Haiku 0.0
