# Darwin V2 — LLM 라우팅 정책

> 최종 업데이트: 2026-04-18

---

## 개요

Darwin V2의 각 에이전트는 작업 특성에 맞는 LLM을 사용합니다. 비용 효율을 위해 **로컬 MLX 우선, 클라우드는 가치 있는 곳에만** 원칙을 따릅니다.

---

## 일일 예산

```
DARWIN_LLM_DAILY_BUDGET_USD = 10 (USD)
DARWIN_LLM_PER_PAPER_BUDGET_USD = 5 (USD)
```

예산 80% 도달 시 `budget_warning` 이벤트 발행. 100% 도달 시 당일 파이프라인 중단.

---

## 에이전트별 LLM 정책

### scanner (논문 스캐너)

```yaml
route: local_fast           # qwen2.5-7b (로컬 MLX)
fallback: [groq_haiku]
```

**이유**: 키워드 추출, RSS 파싱은 빠른 소형 모델로 충분. 비용 $0 (로컬).

---

### evaluator (논문 평가)

```yaml
route: anthropic_sonnet     # Claude Sonnet
fallback: [groq_qwen3_32b, local_deep]
```

**이유**: 논문 품질 판단은 정확도가 중요. Sonnet의 긴 컨텍스트 이해력 활용.

---

### planner (구현 계획 수립)

```yaml
route: anthropic_sonnet
fallback: [groq_qwen3_32b, local_deep]
```

**이유**: 원자적 컴포넌트 분해, 자원 추정은 복잡한 추론 필요.

---

### edison (코드 생성)

```yaml
route: anthropic_sonnet
fallback: [groq_qwen3_32b, local_deep]
```

**이유**: 실제 코드 생성. 품질이 검증 성공률에 직결됨.

---

### verifier (검증)

```yaml
route: anthropic_sonnet
fallback: [groq_qwen3_32b, local_deep]
```

**이유**: 테스트 결과 해석, 검증 로직 작성은 정확한 추론 필요.

---

### commander (오케스트레이션)

```yaml
route: anthropic_opus       # Claude Opus
fallback: [anthropic_sonnet]
```

**이유**: 전체 파이프라인 조율, 복잡한 판단, 예외 처리. Opus의 최고 추론 능력 활용.

---

### reflexion (자기 성찰)

```yaml
route: anthropic_sonnet
fallback: [local_deep]
```

**이유**: 실패 패턴 분석, 전략 수정은 깊은 반성 능력 필요.

---

### espl (프롬프트 진화)

```yaml
route: local_fast           # qwen2.5-7b
fallback: [groq_haiku]
```

**이유**: 프롬프트 변이(mutation)는 창의성보다 다양성이 중요. 주 1회 실행.

---

### self_rag (Self-RAG 게이트)

```yaml
route: local_fast           # qwen2.5-7b
fallback: [groq_haiku]
```

**이유**: 4-gate 분류는 단순 이진 판단. 빠른 소형 모델로 충분.

---

## LLM 제공자 레이블 정의

| 레이블 | 실제 모델 | 비용 |
|--------|----------|------|
| `local_fast` | qwen2.5-7b (MLX 로컬) | $0 |
| `local_deep` | deepseek-r1-32b (MLX 로컬) | $0 |
| `groq_haiku` | Groq API 경유 소형 모델 | ~$0.001/1K |
| `groq_qwen3_32b` | Groq Qwen3-32B | ~$0.003/1K |
| `anthropic_sonnet` | claude-sonnet-4-6 | ~$0.015/1K |
| `anthropic_opus` | claude-opus-4 | ~$0.075/1K |

---

## 비용 추적

모든 LLM 호출은 `darwin_v2_llm_routing_log` 테이블에 기록됩니다.

```sql
-- 오늘 에이전트별 비용 조회
SELECT agent_name, SUM(cost_usd) as total_cost
FROM darwin_v2_llm_routing_log
WHERE inserted_at >= CURRENT_DATE
GROUP BY agent_name
ORDER BY total_cost DESC;
```

---

## 폴백 정책

1. 기본 모델 실패(타임아웃/오류) → 폴백 체인 순서대로 시도
2. 모든 폴백 실패 → `fallback_used=true`, `response_ok=false` 기록
3. 연속 3회 실패 → Commander에게 경보 발행
4. `budget_ratio >= 0.8` → 로컬 모델로 강제 다운그레이드
