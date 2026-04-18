# PodSelectorV2 — 운영 가이드

> `Sigma.V2.PodSelectorV2` — Phase P Multi-Armed Bandit Pod 선택

## 개요

3 Pod(trend/growth/risk) 중 최적 Pod를 동적으로 선택하는 Bandit 시스템.
Kill Switch OFF 시 기존 ε-greedy로 fallback.

## Kill Switch

```bash
# 활성화 (UCB1 기본)
SIGMA_POD_DYNAMIC_V2_ENABLED=true

# 비활성화 (ε-greedy fallback, 기본값)
SIGMA_POD_DYNAMIC_V2_ENABLED=false
```

## 4가지 선택 전략

### 1. ε-greedy (Kill Switch OFF 시 기본값)
- 20% 확률로 랜덤 탐색
- 80% 확률로 `avg_reward` 최고 Pod 선택
- 최소 DB 의존성, 안전한 기본값

### 2. UCB1 (Kill Switch ON 시 기본값)
```
score = avg_reward + C × √(ln(N) / n_i)
C = 1.414 (√2)
```
- `N`: 전체 시도 수, `n_i`: Pod별 시도 수
- 적게 시도된 Pod에 탐색 보너스 부여

### 3. Thompson Sampling
```elixir
# Beta(α, β) 분포에서 샘플링 (Johnk's method)
x = pow(rand(), 1/α)
y = pow(rand(), 1/β)
sample = x / (x + y)
```
- α = successes + 1, β = failures + 1
- 확률론적 탐색 — 불확실성 높을수록 더 많이 탐색

### 4. Contextual
- 과거 선택 로그에서 상황 유사도 계산
- 최근 선택에 시간 감쇠 가중치 적용 (반감기 168시간)
- 컨텍스트 키: `target_team`, `time_of_day`, `weekday`, `urgency`

## 전략 선택 방법

```elixir
# UCB1 (기본)
Sigma.V2.PodSelectorV2.select_best_pod("blog", %{})

# Thompson Sampling
Sigma.V2.PodSelectorV2.select_best_pod("blog", %{strategy: :thompson})

# Contextual
Sigma.V2.PodSelectorV2.select_best_pod("blog", %{
  strategy: :contextual,
  target_team: "blog",
  time_of_day: "morning",
  weekday: "monday"
})

# ε-greedy 강제
Sigma.V2.PodSelectorV2.select_best_pod("blog", %{strategy: :epsilon_greedy})
```

## 보상 업데이트

```elixir
# 사이클 완료 후 실제 성과 반영 (0.0 ~ 1.0)
Sigma.V2.PodSelectorV2.update_reward("trend", "blog", 0.85)

# reward >= 0.5 → success_inc = 1
# reward < 0.5  → failure_inc = 1
```

## DB 테이블

### `sigma_pod_bandit_stats`
| 컬럼 | 설명 |
|------|------|
| `pod_name` | trend / growth / risk |
| `target_team` | 대상 팀 (luna/darwin/blog 등) |
| `trials` | 총 선택 횟수 |
| `successes` | 성공 횟수 (reward >= 0.5) |
| `failures` | 실패 횟수 |
| `avg_reward` | 평균 보상 |

### `sigma_pod_selection_log`
| 컬럼 | 설명 |
|------|------|
| `pod_name` | 선택된 Pod |
| `strategy` | 사용된 전략 |
| `context` | JSONB 컨텍스트 |
| `actual_reward` | 실제 보상 (feedback 수신 후) |
| `feedback_received_at` | 보상 수신 시각 |

## 통계 조회

```elixir
# 팀별 Pod 성과 (30일)
Sigma.V2.PodSelectorV2.pod_stats("blog", 30)
# => [%{pod_name: "trend", trials: 45, avg_reward: 0.82}, ...]
```

## 주의사항

- `pod_name` guard: `"trend" | "growth" | "risk"` 외 값 → `FunctionClauseError`
- DB 없어도 rescue로 `:ok` 반환 (graceful degradation)
- `log_selection`은 best-effort — 실패해도 선택 결과에 영향 없음
