# Sigma V2 LLM Hub 연동 가이드

> 작성: CODEX_LLM_ROUTING_REFACTOR / 2026-04-18

## 개요

`Sigma.V2.LLM.Selector`는 Hub `/hub/llm/call` 엔드포인트를 통해 Claude Code OAuth (Primary) + Groq (Fallback) 체인을 사용합니다.

## 호출 흐름

```
Sigma 에이전트
  → Selector.call_with_fallback(agent_name, prompt, opts)
  → Recommender.recommend(agent_name, context)   # 7차원 점수 → abstract model
  → HubClient.call(%{prompt, abstract_model, ...})
  → Hub POST /hub/llm/call
  → Claude Code OAuth → (실패 시) Groq 폴백
  → RoutingLog.record(...)   # sigma_v2_llm_routing_log
```

## 환경변수

```bash
LLM_HUB_ROUTING_ENABLED=false   # true = Hub 경유 (기본 false = 직접 Anthropic)
LLM_HUB_ROUTING_SHADOW=true     # true = 양쪽 병렬 실행 (결과는 직접 호출 반환)
HUB_BASE_URL=http://localhost:7788
HUB_AUTH_TOKEN=<토큰>
```

## 단계적 활성화

```
Step 1: LLM_HUB_ROUTING_SHADOW=true  → 3일 병렬 실행, 결과 비교
Step 2: LLM_HUB_ROUTING_ENABLED=true → Hub 경유로 전환
Step 3: 3일 관찰 후 안정화
```

## launchd 설정

`bots/sigma/launchd/ai.sigma.daily.plist` 환경변수:
- `LLM_HUB_ROUTING_ENABLED=false` (기본)
- `LLM_HUB_ROUTING_SHADOW=true`

## 모듈 구조

| 모듈 | 역할 |
|------|------|
| `Sigma.V2.LLM.Selector` | 게이트웨이 — Hub/직접 분기 |
| `Sigma.V2.LLM.HubClient` | Hub HTTP 클라이언트 |
| `Sigma.V2.LLM.Recommender` | 7차원 모델 추천 |
| `Sigma.V2.LLM.RoutingLog` | DB 기록 (`sigma_v2_llm_routing_log`) |
| `Sigma.V2.LLM.CostTracker` | 비용 누적 |

## DB 테이블

`sigma_v2_llm_routing_log`:
- agent_name, model_primary, model_used, fallback_used
- prompt_tokens, response_tokens, latency_ms, cost_usd
- response_ok, error_reason, urgency, task_type, budget_ratio
- **provider** (`direct_anthropic` | `claude-code-oauth` | `groq`)

## Shadow Mode 비교

Shadow Mode에서는 Hub 호출과 직접 호출을 동시에 실행합니다.
- Hub 결과: `[sigma/llm/shadow] {agent} — hub=true, direct=true`
- 레이턴시 차이: `[sigma/llm/shadow] {agent} 레이턴시 차이: {N}ms`

3일 이상 관찰 후 품질/비용/레이턴시 비교 → `LLM_HUB_ROUTING_ENABLED=true` 전환 결정.
