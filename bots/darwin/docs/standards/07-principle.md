# Darwin V2 — 연구 원칙 (Principle Engine)

> 최종 업데이트: 2026-04-18

---

## 개요

Darwin의 원칙 엔진은 파이프라인 전 단계에서 행동 규범을 강제합니다. 원칙은 Tier 0~3의 4단계로 분류되며, 높은 Tier일수록 강한 강제력을 가집니다.

---

## Tier 분류

### Tier 0 — 관찰 (Observation)

**동작**: 기록만 함. 파이프라인 진행에 영향 없음.

```
action: log_only
pipeline: continue
notification: none
```

**예시 상황**:
- 논문이 기존에 평가된 주제와 유사함
- 예상보다 처리 시간이 오래 걸림
- 비용이 평균보다 20% 이상 높음

---

### Tier 1 — 신호 (Signal)

**동작**: 마스터/팀장에게 알림 발송. 파이프라인은 계속 진행.

```
action: alert_only
pipeline: continue
notification: jaybus.emit('darwin.advisory.all', ...)
```

**예시 상황**:
- 같은 논문이 3회 이상 재발견됨
- Edison 코드 생성 실패율이 30%를 초과
- 일일 예산의 50%를 사용

---

### Tier 2 — 경고 (Warning)

**동작**: 마스터에게 검토 요청. `DARWIN_PRINCIPLE_BLOCK_ON_WARN=true`이면 파이프라인 일시 중단.

```
action: request_review
pipeline: pause (if DARWIN_PRINCIPLE_BLOCK_ON_WARN=true)
notification: jaybus.emit('darwin.warning', ...)
```

**예시 상황**:
- 논문 출처가 신뢰할 수 없는 저널
- 구현 비용 추정이 예산의 80%를 초과
- 검증 없이 코드 적용 시도 감지

---

### Tier 3 — 금지 (Prohibition)

**동작**: 해당 행동을 즉시 차단. 파이프라인 중단. 마스터 알림.

```
action: block
pipeline: stop
notification: urgent_alert + jaybus.emit('darwin.principle_violation', ...)
```

---

## Darwin Tier 3 원칙 (절대 금지)

다음 5가지는 어떤 자율성 레벨에서도 자동으로 수행될 수 없습니다.

### 1. 표절 금지

```
원칙: 타인의 코드/텍스트를 무단으로 복사하여 적용하지 않는다.
검사: 생성된 코드가 외부 소스와 90% 이상 일치할 경우 차단.
```

### 2. 검증 없이 main 적용 금지

```
원칙: 검증(verifier) 단계를 통과하지 않은 코드는 절대 main 브랜치에 적용하지 않는다.
검사: pipeline_audit에서 verification_passed 상태 확인 필수.
```

### 3. 재현 불가 논문 폐기

```
원칙: 실험 결과를 재현할 수 없는 논문은 구현하지 않고 폐기한다.
검사: verifier가 3회 이상 재현 실패 → 자동 폐기 + 메모리에 'AVOID' 기록.
```

### 4. 비용 상한 $5/논문 준수

```
원칙: 논문 1편 처리에 $5 이상의 LLM 비용을 사용하지 않는다.
검사: pipeline_audit의 cost_usd 합산이 $5 초과 시 즉시 중단.
환경변수: DARWIN_LLM_PER_PAPER_BUDGET_USD
```

### 5. OPS 직접 수정 금지

```
원칙: Darwin이 OPS 서버(맥 스튜디오)의 파일을 직접 수정하지 않는다.
검사: 파일 쓰기 작업이 감지될 경우 즉시 차단.
방법: 모든 코드 변경은 git PR을 통해 DEV에서 수행.
```

---

## 원칙 검사 시점

| 시점 | 검사 내용 |
|------|----------|
| 논문 평가 전 | 출처 신뢰도, 중복 검사 |
| 구현 계획 수립 후 | 비용 추정 검사 |
| Edison 코드 생성 후 | 표절 검사, 코드 품질 |
| 적용(apply) 직전 | 검증 상태 확인, OPS 접근 검사 |

---

## LLM 기반 의미론적 검사

`DARWIN_PRINCIPLE_SEMANTIC_CHECK=true`이면 Haiku를 사용하여 더 정교한 원칙 위반 검사를 수행합니다.

```
검사 범위: Tier 2, Tier 3 원칙
모델: local_fast (qwen2.5-7b)
폴백: groq_haiku
비용: ~$0.001/검사 (로컬이면 $0)
```

기본값(`false`)에서는 규칙 기반 정적 검사만 수행합니다.
