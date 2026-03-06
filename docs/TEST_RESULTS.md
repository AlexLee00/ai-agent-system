# 테스트 결과 이력

> Day별 테스트 통과/실패 누적 기록

---

## 2026-03-07

### Day 4 — 루나팀 매매일지 (2026-03-06)

| 테스트 | 결과 |
|--------|------|
| insertJournalEntry 기록 | ✅ |
| insertRationale (tradeId, review) 기록 | ✅ |
| closeJournalEntry 청산 | ✅ |
| insertReview 사후평가 | ✅ |
| DuckDB 5개 테이블 생성 확인 | ✅ |
| schema_migrations v4 등록 | ✅ |

### Day 5 — OpenClaw 멀티에이전트 (2026-03-06)

| 테스트 | 결과 |
|--------|------|
| team-comm sendToTeamLead | ✅ |
| team-comm getPendingMessages 수신 | ✅ |
| heartbeat.js require 정상 | ✅ |
| openclaw.json teamLeads 등록 | ✅ |
| SOUL.md 3개 생성 (ska/claude-lead/luna) | ✅ |
| 통합 검증 24/24 | ✅ |

### Day 6 — 독터 + 보안 + OPS/DEV (2026-03-07)

| 테스트 | 결과 |
|--------|------|
| doctor.js 화이트리스트 5개 canRecover | ✅ |
| rm-rf 블랙리스트 차단 | ✅ |
| DROP TABLE 블랙리스트 차단 | ✅ |
| 미등록 작업 거부 | ✅ |
| doctor_log 테이블 생성 + 이력 기록 | ✅ |
| mode-guard ensureOps DEV에서 차단 | ✅ |
| mode-guard ensureDev DEV에서 통과 | ✅ |
| deploy-ops.sh 5단계 확인 | ✅ |
| pre-commit secrets.json/config.yaml 차단 | ✅ |
| .gitignore secrets/config.yaml/db/key | ✅ |
| security.js pre-commit 훅 점검 추가 | ✅ |
| Day 6 검증 15/15 | ✅ |

### Day 7 — 통합 테스트 (2026-03-07)

| 카테고리 | 테스트 | 결과 |
|----------|--------|------|
| 스카팀 State Bus | emitEvent→markProcessed 사이클 | ✅ |
| 스카팀 State Bus | createTask→completeTask 사이클 | ✅ |
| 클로드팀 | 덱스터 퀵체크 | ✅ 이상 없음 |
| 클로드팀 | 독터 canRecover / 블랙리스트 / getAvailableTasks | ✅ |
| 클로드팀 | DexterMode Normal→Emergency→Normal | ✅ |
| 루나팀 | 매매일지 전체 사이클 (기록→판단→청산→평가) | ✅ |
| 크로스팀 | team-comm 클로드→스카 메시지 | ✅ |
| LLM 인프라 | llm-router selectModel | ✅ |
| LLM 인프라 | llm-cache 저장→히트 | ✅ |
| LLM 인프라 | llm-logger logLLMCall | ✅ |

### 안정화 기준선 v3.2.0 (2026-03-07)

| 항목 | 값 | 비고 |
|------|-----|------|
| 버전 | v3.2.0 | |
| state.db 테이블 수 | 17개 | reservations~doctor_log |
| 덱스터 체크 모듈 수 | 15개 | 11 기존 + 4 v2 신규 |
| 덱스터 전시스템 점검 | ✅ 이상 없음 | 2026-03-07 실행 |
| 덱스터 퀵체크 | ✅ 이상 없음 | |
| 스카팀 E2E | ✅ | State Bus 포함 |
| 루나팀 크립토 | ✅ OPS | PAPER_MODE=false |
| TP/SL OCO 설정률 | 100% | OPS 진입 시 필수 |
| 독터 화이트리스트 | 5개 | |
| 독터 블랙리스트 | 9개 | |
| LLM 일간 비용 | $0.00 | 기준일 기준 |
| 월간 예산 사용률 | 0% / $10 | |
| secrets 노출 | 0건 | |
| pre-commit 훅 | 설치됨 | |

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

### Day 3 — llm-logger + llm-router + llm-cache (2026-03-06)

| 테스트 | 결과 |
|--------|------|
| llm-logger: logLLMCall DB 기록 | ✅ |
| llm-logger: getDailyCost 비용 집계 | ✅ |
| llm-router: ska status_check → simple/Groq | ✅ |
| llm-router: luna trade_decision → complex/Sonnet | ✅ |
| llm-router: claude architecture_review → deep/Opus | ✅ |
| llm-router: 긴급도 상향 (ska simple → medium) | ✅ |
| llm-cache: getCached 미스 → null | ✅ |
| llm-cache: setCache + getCached 히트 | ✅ |
| llm-cache: getCacheStats 집계 | ✅ |
| llm-cache: cleanExpired 만료 삭제 | ✅ |
| state.db 테이블 자동 생성 (llm_usage_log, llm_cache) | ✅ |

### False Positive 수정 (2026-03-06)

| 수정 | 결과 |
|------|------|
| openclaw.js IPv6 `[::1]` 파싱 수정 | ✅ 실행 시 status: ok |
| dexter-quickcheck.js 수동 실행 | ✅ 이상 없음 |
