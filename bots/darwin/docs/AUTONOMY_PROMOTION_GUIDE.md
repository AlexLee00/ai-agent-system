# Darwin 자율 레벨 승격 가이드

> 작성: 코덱스 / 2026-04-19

## 레벨 체계

| 레벨 | 명칭 | 권한 |
|------|------|------|
| L3 | 에러 복구 | 구현 전 마스터 승인 필수 |
| L4 | 부분 자율 | 구현 자동, 적용 전 마스터 승인 필수 |
| L5 | 완전 자율 | 검증 통과 시 자동 적용 (DARWIN_L5_ENABLED 필수) |

## 승격 조건

### L3 → L4

- 최근 30일 성공 사이클 **5회 이상**
- 경과 **7일 이상**
- 원칙 위반 **0회**

### L4 → L5

- 최근 60일 성공 사이클 **10회 이상**
- 적용 완료 사이클 **3회 이상**
- 경과 **14일 이상**
- `DARWIN_L5_ENABLED=true` 환경변수 설정 (마스터 직접)

## 승격 절차 (불변)

1. `Darwin.V2.AutonomyLevel.check_promotion_conditions` 자동 감지
2. Telegram urgent 알림 전송 (자동 flip 절대 없음)
3. 마스터가 조건 확인 후 승인 결정
4. 마스터가 직접 환경변수 설정:
   - L4: `launchctl setenv DARWIN_AUTONOMY_LEVEL 4`
   - L5: `launchctl setenv DARWIN_AUTONOMY_LEVEL 5` + `launchctl setenv DARWIN_L5_ENABLED true`
5. `darwin_autonomy_promotion_log` 테이블에 자동 기록

## 강등 조건 (자동)

- 연속 실패 3회 → 현재 레벨 -1 강등
- 원칙 위반 발생 → L3 강제 강등 + Telegram 알림

## 모니터링

```sql
-- 현재 레벨 확인
SELECT * FROM darwin_autonomy_promotion_log ORDER BY inserted_at DESC LIMIT 5;

-- 승격 후보 조건 확인
SELECT
  COUNT(*) FILTER (WHERE status = 'success') AS successes,
  COUNT(*) FILTER (WHERE stage = 'applied') AS applications,
  MIN(started_at) AS oldest_cycle
FROM darwin_cycle_history
WHERE started_at > NOW() - INTERVAL '30 days';
```

## 주의사항

- L5 자동 flip은 **시스템 내에서 절대 불가** (코드 레벨 강제 차단)
- L5 상태에서도 Sandbox 격리 유지 — 메인 코드 직접 수정 금지
- Telegram 알림 후 48시간 내 마스터 미응답 시 후보 로그만 유지, 재알림 없음
