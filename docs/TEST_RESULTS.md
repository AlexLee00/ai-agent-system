# 테스트 결과 이력

> Day별 테스트 통과/실패 누적 기록

---

## 2026-03-06

### Day 1 — State Bus + TP/SL OCO (16/16 ✅)

| 테스트 | 결과 |
|--------|------|
| State Bus emitEvent/getUnprocessedEvents | ✅ |
| State Bus createTask/completeTask | ✅ |
| TP/SL OCO 가격 계산 정확도 | ✅ |
| OCO PAPER_MODE 생략 | ✅ |
| 기존 E2E 27/27 | ✅ |

### Day 2 — 덱스터 v2 (16/16 ✅)

| 테스트 | 결과 |
|--------|------|
| DexterMode Normal→Emergency 전환 | ✅ |
| DexterMode Emergency→Normal 복귀 | ✅ |
| DexterMode 상태 파일 지속 | ✅ |
| team-leads.js 핵심 봇 점검 | ✅ |
| openclaw.js launchd+포트+메모리 | ✅ |
| llm-cost.js 예산 임계 | ✅ |
| workspace-git.js uncommitted 감지 | ✅ |
| dexter.js v2 모듈 통합 | ✅ |
| dexter-quickcheck.js v2 팀장 점검 | ✅ |

### False Positive 수정 (2026-03-06)

| 수정 | 결과 |
|------|------|
| openclaw.js IPv6 `[::1]` 파싱 수정 | ✅ 실행 시 status: ok |
| dexter-quickcheck.js 수동 실행 | ✅ 이상 없음 |
