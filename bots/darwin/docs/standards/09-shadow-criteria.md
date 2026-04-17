# Darwin V2 — Shadow Mode 기준 (Shadow Criteria)

> 최종 업데이트: 2026-04-18

---

## 개요

Shadow Mode는 Darwin V2를 V1과 병행 실행하여 결과를 비교합니다. 7일 관찰 후 match_score ≥ 95% 달성 시 V2 단독 운영으로 전환.

---

## 활성화

```bash
DARWIN_SHADOW_ENABLED=true
```

---

## 실행 스케줄

- **주기**: 일 1회 (V1 daily cycle과 동일 시간)
- **트리거**: `Darwin.V2.ShadowRunner.run_once()`
- **launchd**: `ai.darwin.daily.shadow.plist`

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
3. 마스터 명시 승인 (자동 승격 불가 — L5에서도 동일)
4. `DARWIN_CYCLE_ENABLED=true` 설정
5. `DARWIN_SHADOW_ENABLED=false` 설정 (V1 병행 중단)

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
