# Darwin V2 — JayBus 시그널 토픽 정의

> 최종 업데이트: 2026-04-18

---

## 개요

Darwin V2는 JayBus를 통해 팀 간 통신을 수행합니다. 모든 이벤트는 비동기로 발행되며, 토픽 명명 규칙은 `{서비스}:{카테고리}.{세부}` 형식을 따릅니다.

---

## 외부 토픽 (타 팀 → Darwin / Darwin → 타 팀)

### Darwin이 발행하는 토픽

| 토픽 | 설명 | 페이로드 |
|------|------|----------|
| `paper_discovered` | 새 논문 발견 | `{ paper_id, url, title, source }` |
| `paper_evaluated` | 논문 평가 완료 | `{ paper_id, score, rationale, tier }` |
| `paper_rejected` | 논문 기각 | `{ paper_id, reason, score }` |
| `implementation_ready` | 구현 계획 완성 | `{ plan_id, paper_id, assigned_to }` |
| `verification_passed` | 검증 통과 | `{ plan_id, paper_id, test_results }` |
| `verification_failed` | 검증 실패 | `{ plan_id, paper_id, error, rollback_done }` |
| `applied/{team}` | 특정 팀에 적용 완료 | `{ plan_id, paper_id, team, commit_sha }` |
| `apply_failed/{team}` | 특정 팀 적용 실패 | `{ plan_id, paper_id, team, error }` |

### Darwin이 구독하는 토픽

| 토픽 | 발행자 | 설명 |
|------|--------|------|
| `darwin:trigger.scan` | 마스터/Jay | 수동 스캔 트리거 |
| `darwin:kill_switch` | 마스터/Jay | 긴급 중단 명령 |
| `jay:budget.alert` | Jay Hub | 비용 경고 알림 |

---

## V2 내부 토픽 (Darwin 내부 파이프라인)

| 토픽 | 발행자 | 구독자 | 설명 |
|------|--------|--------|------|
| `plan_ready` | Planner | Edison | 구현 계획 준비 완료 |
| `shadow_result` | V2 파이프라인 | Archivist | 섀도우 실행 결과 |
| `reflexion_stored` | Reflexion | Commander | 성찰 메모리 저장 완료 |
| `espl_evolved` | ESPL | Commander | 프롬프트 진화 완료 |
| `budget_warning` | Cost Tracker | Commander | 일일 예산 80% 도달 |
| `kill_switch_activated` | Commander | 전체 에이전트 | 긴급 중단 신호 |

---

## Darwin Advisory 시그널 토픽

Darwin이 다른 팀에 연구 인사이트를 전달하는 전용 채널입니다.

| 토픽 | 대상 | 설명 |
|------|------|------|
| `darwin:darwin.advisory.sigma` | 시그마 | 시그마 개선 관련 논문 인사이트 |
| `darwin:darwin.advisory.luna` | 루나 | 투자 전략 관련 연구 결과 |
| `darwin:darwin.advisory.worker` | 워커 | SaaS 기능 관련 연구 결과 |
| `darwin:darwin.advisory.eddiy` | 에디 | 영상 처리 관련 연구 결과 |
| `darwin:darwin.advisory.all` | 전체 팀 | 범용 연구 인사이트 |

---

## 토픽 명명 규칙

```
{namespace}:{category}.{subject}[.{detail}]

예시:
  paper_discovered           # Darwin 외부 발행 (짧은 형식)
  darwin:darwin.advisory.sigma  # Darwin Advisory (네임스페이스 포함)
  applied/sigma              # 팀별 적용 완료 (경로 형식)
```

---

## 페이로드 표준 필드

모든 Darwin 발행 이벤트에는 다음 공통 필드가 포함됩니다:

```json
{
  "event_id": "uuid-v4",
  "emitted_at": "2026-04-18T09:00:00+09:00",
  "source": "darwin_v2",
  "autonomy_level": 3,
  "pipeline_run_id": "uuid-v4",
  ...이벤트별 페이로드
}
```
