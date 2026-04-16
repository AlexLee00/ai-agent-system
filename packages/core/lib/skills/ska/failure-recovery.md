# SKA Skill: Failure Recovery

## 목적
에이전트 실패를 자동 감지, 분류, 복구하는 자기 치유 루프.
Phase 1→2→3 자율 단계 전환을 통해 마스터 개입 월 0회 목표.

## 실패 분류
```
:network_error  — ECONNREFUSED, ERR_NETWORK, fetch failed
:selector_broken — detached Frame, selector not found, No node found
:timeout        — TimeoutError, Navigation timeout, Waiting failed
:auth_expired   — 401, Unauthorized, session expired, 로그인 필요
:unknown        — 미분류
```

## 자동 복구 전략
```
network_error  → 지수 백오프 재시도 (최대 3회, 5s→10s→20s)
selector_broken → ParsingGuard Level 2/3 폴백 + SelectorManager 캐시 무효화
timeout        → 타임아웃 2배 증가 재시도
auth_expired   → NaverSession 재로그인 트리거 (최대 3회)
unknown        → DB 등록 + 텔레그램 알림
```

## 핵심 API

### FailureTracker (Elixir GenServer)
```elixir
# 실패 보고 (Node.js에서도 호출 가능 - ska-failure-reporter.ts 경유)
TeamJay.Ska.FailureTracker.report(%{
  agent: "andy",
  error_type: :network_error,    # atom 또는 string
  message: "ECONNREFUSED ...",
  target: "naver_list"           # 선택
})

TeamJay.Ska.FailureTracker.get_recent/1    # 최근 실패 목록 (DB)
TeamJay.Ska.FailureTracker.get_stats/0     # 통계 (total, auto_resolved 등)
TeamJay.Ska.FailureTracker.get_phase/0     # 현재 자율 Phase (1/2/3)
TeamJay.Ska.FailureTracker.set_phase/1     # Phase 전환 (Orchestrator 호출)
```

### Node.js 연동 (ska-failure-reporter.ts)
```typescript
import { createSkaReporter } from '../../lib/ska-failure-reporter';

// ErrorTracker onReport 콜백으로 등록
const tracker = createErrorTracker({
  onReport: createSkaReporter('andy')  // fire-and-forget
});
```

## 자율 Phase 전환 (Orchestrator)
```
Phase 1 (감시 모드)
  - 복구율 목표: 50%+
  - 알림: 모든 복구 시도 텔레그램 발송
  - → Phase 2 전환 조건: 복구율 80%+ (매일 KPI 체크)

Phase 2 (반자율)
  - 복구율 목표: 80%+
  - 알림: 실패 복구만 (성공은 로그)
  - → Phase 3 전환 조건: 복구율 95%+

Phase 3 (완전 자율)
  - 복구율 목표: 95%+
  - 알림: 주간 리포트만
  - KPI: 마스터 개입 월 0회
```

## 에스컬레이션
- 동일 에러 3회 이상 → 자동 복구 시도
- 동일 에러 5회 이상 → 텔레그램 에스컬레이션 + EventLake severity=critical

## DB 테이블
- `ska.failure_cases` — 실패 케이스 이력
  - `error_type, error_message, agent, count`
  - `first_seen, last_seen, auto_resolved, resolution`
  - 고유 키: `(agent, error_type, md5(error_message))`

## DB 폴링
- 60초마다 `auto_resolved=FALSE AND count >= 3` 조회
- Node.js 에이전트가 직접 기록한 실패도 자동 수집
