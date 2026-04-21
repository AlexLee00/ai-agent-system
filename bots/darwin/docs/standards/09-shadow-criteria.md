# Darwin V2 — Shadow Mode 기준 (Shadow Criteria)

> 최종 업데이트: 2026-04-20

---

## 개요

Shadow Mode는 Darwin V2를 V1과 병행 실행하여 결과를 비교하는 승격 전 단계입니다. 현재 live Darwin은 이미 `L5 완전자율`로 전환되었고, 이 문서는 **과거 shadow 승격 기준**을 보존하는 용도입니다.

---

## 활성화

```bash
DARWIN_SHADOW_MODE=true
```

---

## 실행 스케줄

- **주기**: 주 1회 one-shot 검증 또는 승격 전 관찰 기간에 맞춘 임시 운영
- **트리거**: `Darwin.V2.ShadowRunner.run_once()`
- **과거 launchd**: `ai.darwin.daily.shadow.plist` (현재 live는 `ai.darwin.weekly.autonomous.plist`)

---

## 비교 지표 (Match Score)

Jaccard 유사도 기반:

```
match_score = |V1_papers ∩ V2_papers| / |V1_papers ∪ V2_papers|
```

목표: **match_score ≥ 0.95** (7일 연속)

---

## 전환 기준

| 조건 | 임계값 |
|------|--------|
| Shadow 실행 일수 | ≥ 7일 |
| 평균 match_score | ≥ 0.95 |
| 에러율 | ≤ 5% |
| L4 이상 자율 레벨 | 필수 |

---

## Shadow 결과 저장

DB 테이블: `darwin_v2_shadow_runs`

```sql
SELECT run_date, match_score, notes
FROM darwin_v2_shadow_runs
ORDER BY run_date DESC
LIMIT 7;
```

---

## 전환 절차

1. Shadow 7일 관찰 완료
2. 메티 검토 → match_score 확인
3. 마스터 명시 승인
4. `DARWIN_CYCLE_ENABLED=true` 설정
5. `DARWIN_SHADOW_MODE=false` 설정 (V1 병행 중단)

---

## 롤백 기준

V2 정식 운영 전환 후에도 지속 모니터링합니다.

| 이벤트 | 조치 |
|--------|------|
| match_score < 90% | Tier 1 경고 → 마스터 알림 |
| match_score < 80% | 즉시 자동 롤백 → V1 복구 → 마스터 긴급 알림 |

롤백 후에는 Shadow 모드로 돌아가며, 새 승격 기준을 처음부터 충족해야 합니다.

---

## Shadow 데이터 보존

- 보존 기간: 90일 (주간 배치 자동 삭제)
- 예외: `match_score < 0.80`인 기록은 영구 보존 (실패 학습용)

---

## 현재 live 상태

- 현재 Darwin live는 shadow 승격 단계를 이미 통과한 상태다.
- live 운영값:
  - `DARWIN_SHADOW_MODE=false`
  - `DARWIN_AUTONOMY_LEVEL=5`
  - `DARWIN_TIER2_AUTO_APPLY=true`
  - `DARWIN_KILL_SWITCH=false`
