# Gemini Flash 임시 Fallback 운영 기준

## 목적

이 문서는 `google-gemini-cli/gemini-2.5-flash`가 `rate_limited` 또는 유사한 운영 장애 상태에 들어갔을 때, 내부 MVP 단계에서 `google-gemini-cli/gemini-2.5-flash-lite`를 임시 primary 후보로 검토하는 기준을 고정한다.

현재 목적은 자동 전환이 아니라 **운영 승인형 임시 전환 기준**을 만드는 것이다.

## 현재 기준점

- 현재 primary: `google-gemini-cli/gemini-2.5-flash`
- 현재 primary health: `rate_limited`
- current same-provider fallback candidate: `google-gemini-cli/gemini-2.5-flash-lite`
- selector recommendation: `compare`
- global speed winner: `groq/openai/gpt-oss-20b`

중요한 점:
- `speed winner`와 `temporary fallback candidate`는 같은 개념이 아니다.
- 현재는 cross-provider 즉시 전환보다 **same-provider 임시 fallback**이 운영적으로 더 안전하다.

## 관측 사실

최근 speed-test 기준:
- `gemini-2.5-flash`: `HTTP 429`, `rate_limited`
- `gemini-2.5-pro`: 정상 측정 복구
- `gemini-2.5-flash-lite`: 정상 측정

최근 selector review 기준:
- `primaryHealth = rate_limited`
- `primaryFallbackCandidate = google-gemini-cli/gemini-2.5-flash-lite`
- `primaryFallbackPolicy = temporary_fallback_candidate`
- `consecutivePrimaryIssues = 3`

즉 현재는 “전환 확정”이 아니라,
**임시 fallback 운영 검토 조건이 충족된 상태**로 본다.

## 해석 원칙

### 지금 당장 필요한 구조

- primary health와 recommendation을 분리해서 본다.
- 같은 provider 안에서 건강한 fallback이 있으면 먼저 그 후보를 검토한다.
- 자동 전환은 하지 않고 운영 승인 후 적용한다.

### 나중에 확장할 구조

- `temporary_fallback_candidate`
- `switch_candidate`
- `auto_switch_allowed`
- `rollback_candidate`

같은 정책 상태를 공용 selector/gateway policy로 확장한다.

## 임시 전환 조건

아래 조건이 모두 만족될 때만 `flash-lite` 임시 전환을 검토한다.

1. `current primary = google-gemini-cli/gemini-2.5-flash`
2. `primaryHealth in ('rate_limited', 'degraded')`
3. `consecutivePrimaryIssues >= 2`
4. `primaryFallbackCandidate = google-gemini-cli/gemini-2.5-flash-lite`
5. 최신 speed-test에서 `flash-lite`가 실제 성공 상태
6. gateway / selector / 일일 ops report에 추가 중대 장애 신호가 없음

## 전환 금지 조건

아래 중 하나라도 해당하면 임시 전환하지 않는다.

1. `flash-lite`도 실패 또는 degraded
2. 최근 snapshot 수가 너무 적어 일시 오류인지 구분 불가
3. gateway 쪽에서 provider readiness 또는 fallback readiness가 불안정
4. 속도는 괜찮아도 실제 업무 품질 검증이 없는 상태
5. 같은 시점에 broader network/provider 장애가 의심되는 경우

## 임시 전환 절차

1. `speed-test.js` 재실행
2. `llm-selector-speed-review.js`로
   - `primaryHealth`
   - `primaryFallbackCandidate`
   - `primaryFallbackPolicy`
   재확인
3. `flash-lite`를 임시 primary 후보로 승인
4. 변경 후 관찰
   - selector speed review
   - gateway experiment review
   - daily ops report
5. 이상 없으면 임시 유지
6. `flash` 회복 시 rollback 판단

## 롤백 조건

아래 조건이 만족되면 `gemini-2.5-flash` 복귀를 검토한다.

1. `gemini-2.5-flash` 재측정 2회 연속 성공
2. `primaryHealth = healthy`
3. rate limit 경고가 해소됨
4. `flash-lite` 임시 운영 중 품질/속도 이득이 제한적임

## 운영 권고

### 현재 권고

- 즉시 자동 전환: 하지 않음
- 운영 승인형 임시 fallback 검토: 가능
- 우선 후보: `google-gemini-cli/gemini-2.5-flash-lite`

### 이유

- 비즈니스 목표:
  - 내부 MVP에서는 빠른 전환보다 안정적인 복구가 우선
- 서비스 기획 구조:
  - same-provider fallback이 user-perceived behavior 차이를 줄이기 쉽다
- 개발 실현 가능성:
  - 기존 selector review 레이어만으로 판단 가능
- 데이터 구조 및 확장성:
  - policy signal을 공용 상태 코드로 확장 가능
- 운영 안정성:
  - automatic switch보다 승인형 temporary fallback이 더 안전
- SaaS 확장:
  - 추후 workspace별 fallback policy로 확장 가능

## 다음 단계

1. quota reset 이후 `gemini-2.5-flash` 재측정
2. 여전히 `rate_limited`면 `flash-lite` 임시 primary 검토
3. 그 후 selector/gateway 통합 policy 초안으로 확장
