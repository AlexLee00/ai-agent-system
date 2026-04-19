# BudgetGuardian 운영 가이드

> `bots/hub/lib/budget-guardian.ts` | TypeScript Singleton

## 개요

Team Jay 전체 LLM 비용을 팀별 quota + 전체 global limit으로 통합 관리.
Hub 재시작 시 자동 초기화, 60초마다 DB에서 실제 사용량 재계산.

## 팀별 Quota

| 팀 | 일일 한도 | 근거 |
|----|----------|------|
| luna | $30 | 수익 창출 최우선 |
| darwin | $15 | R&D |
| sigma | $10 | 메타 최적화 |
| claude | $10 | 모니터링/복구 |
| blog | $5 | 콘텐츠 생성 |
| worker | $5 | 플랫폼 |
| editor | $3 | 영상 |
| data | $2 | 데이터 |

- **Global 합산 limit**: $80/day
- **Emergency cutoff**: $100 도달 시 전체 LLM 차단

## API

### POST /hub/budget/reserve

예산 예약. 실제 호출 전 통과 여부 확인.

```json
Request:  { "team": "luna", "estimated_cost": 0.01 }
Response: { "ok": true, "globalRatio": 0.45, "teamRatio": 0.48 }
          { "ok": false, "reason": "team_quota_exceeded" }
          { "ok": false, "reason": "global_limit_exceeded" }
          { "ok": false, "reason": "emergency_cutoff" }
```

### GET /hub/budget/usage

현재 사용량 조회.

```json
{
  "ok": true,
  "global_used": 36.2,
  "global_limit": 80.0,
  "global_ratio": 0.45,
  "emergency": false,
  "teams": {
    "luna": { "used": 14.5, "quota": 30.0 },
    "darwin": { "used": 8.2, "quota": 15.0 },
    "blog": { "used": 4.8, "quota": 5.0 }
  }
}
```

## Kill Switch

```bash
# BudgetGuardian 완전 비활성화 (기본: 활성)
launchctl setenv HUB_BUDGET_GUARDIAN_ENABLED false

# 재시작 필요
launchctl stop ai.hub.resource-api
launchctl start ai.hub.resource-api
```

> **주의**: `HUB_BUDGET_GUARDIAN_ENABLED=false` 시 예산 체크가 모두 통과됨.
> 비상시에만 사용.

## 알림 조건

| 조건 | 알림 |
|------|------|
| 팀 quota 80% 도달 | ⚠️ Telegram 경고 |
| Global 80% 도달 ($64) | ⚠️ Telegram 경고 + 팀별 요약 |
| Global 100% ($80) | 🔴 Emergency 차단 |
| Emergency cutoff ($100) | 🚨 전체 LLM 중단 |

## 예산 초과 시 동작

```
1. Unified Caller에서 budget/reserve 호출
2. ok: false 반환 시 LLM 호출 없이 즉시 오류 반환
3. 에러 코드: budget_exceeded: team_quota_exceeded / global_limit_exceeded / emergency_cutoff
4. BudgetGuardian 장애 시 → 통과 (서비스 중단 방지 원칙)
```

## 일일 리셋

자정 KST (UTC 15:00) 자동 리셋 — DB의 오늘 날짜 사용량 재집계.

`refreshFromDb()` 60초마다 실행:
```sql
SELECT caller_team, SUM(cost_usd)
FROM sigma_v2_llm_routing_log
WHERE created_at >= CURRENT_DATE
GROUP BY caller_team
```

(luna_llm_routing_log, darwin_v2_llm_routing_log 동일 패턴)

## 문제 해결

### Emergency 해제

```bash
# DB 사용량 확인
psql jay -c "SELECT caller_team, SUM(cost_usd) FROM sigma_v2_llm_routing_log WHERE created_at >= CURRENT_DATE GROUP BY caller_team;"

# Hub 재시작 → BudgetGuardian 재초기화
launchctl stop ai.hub.resource-api && sleep 2 && launchctl start ai.hub.resource-api
```

### 특정 팀 quota 임시 증가

`bots/hub/lib/budget-guardian.ts`의 `TEAM_QUOTAS` 수정 후 Hub 재시작.
변경 후 반드시 마스터 승인 기록 남길 것.
