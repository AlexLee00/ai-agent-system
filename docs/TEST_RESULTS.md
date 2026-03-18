# 테스트 결과 이력

> Day별 테스트 통과/실패 누적 기록

---

## 2026-03-18

### 자동화 리포트 개선

| 테스트 | 결과 |
|--------|------|
| `node --check bots/orchestrator/scripts/log-jay-gateway-experiment.js` | ✅ |
| `node --check scripts/reviews/jay-gateway-experiment-daily.js` | ✅ |
| `node --check scripts/reviews/daily-ops-report.js` | ✅ |
| `node --check bots/investment/scripts/trading-journal.js` | ✅ |
| `node --check bots/investment/scripts/weekly-trade-review.js` | ✅ |
| `node --check scripts/reviews/jay-llm-daily-review.js` | ✅ |
| `node --check scripts/reviews/ska-sales-forecast-weekly-review.js` | ✅ |
| `node --check scripts/reviews/ska-sales-forecast-daily-review.js` | ✅ |
| `node scripts/reviews/jay-gateway-experiment-daily.js --json` | ✅ fallback 저장 보강 후 `snapshot / persisted / fallbackUsed / review` 확인 |
| `node -e "const {buildRun}=require('./scripts/reviews/jay-gateway-experiment-daily.js'); ..."` | ✅ `persisted=true`, `fallbackUsed=true`, `tmp/jay-gateway-experiments.jsonl` 확인 |
| `node scripts/reviews/daily-ops-report.js --json` | ✅ `activeIssues / historicalIssues / inputFailures` 분리 확인 |
| `node scripts/reviews/daily-ops-report.js` | ✅ 텍스트 리포트 섹션 분리 확인 |
| `node scripts/reviews/jay-llm-daily-review.js --json` | ✅ `dbStatsStatus=partial`, `dbSourceErrors`, `llmUsageSource=session_usage_fallback` 확인 |
| `node scripts/reviews/jay-llm-daily-review.js` | ✅ partial 상태와 fallback 모델별 사용량 출력 확인 |
| `node bots/investment/scripts/weekly-trade-review.js --dry-run` | ✅ no-trade 운영 요약 + 주간 usage / 비용 경고 출력 확인 |
| `node scripts/reviews/ska-sales-forecast-weekly-review.js --days=7 --json` | ✅ `requestedDays / effectiveDays` 및 `actionItems` 확인 |
| `node scripts/reviews/ska-sales-forecast-daily-review.js --days=5 --json` | ✅ `actionItems` 출력 확인 |

### 모바일 알림 UX 정리

| 테스트 | 결과 |
|--------|------|
| `node --check packages/core/lib/telegram-sender.js` | ✅ |
| `node --check packages/core/lib/reporting-hub.js` | ✅ |
| `node --check bots/investment/shared/report.js` | ✅ |
| `node --check bots/orchestrator/lib/batch-formatter.js` | ✅ |
| `node --check bots/investment/scripts/market-alert.js` | ✅ |
| `node --check bots/investment/scripts/pre-market-screen.js` | ✅ |
| 개인 Telegram 직접 전송 `ok=true` | ✅ |
| 그룹 Telegram 직접 전송 `ok=true` | ✅ |
| 루나 토픽 15 직접 전송 `ok=true` | ✅ |
| 실제 수신 화면에서 15자 구분선 1줄 유지 확인 | ✅ |
| 실제 수신 화면에서 테스트 메시지 헤더 중복 제거 확인 | ✅ |

### 워커 웹 `LLM API 현황` / `블로그 URL 입력` 운영 콘솔 정리

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/web/server.js` | ✅ |
| `node --check bots/worker/web/app/admin/monitoring/page.js` | ✅ |
| `node --check bots/worker/web/app/admin/monitoring/blog-links/page.js` | ✅ |
| `node --check bots/worker/web/components/Sidebar.js` | ✅ |
| `node --check bots/worker/web/components/AdminQuickNav.js` | ✅ |
| `cd bots/worker/web && npm run build` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ |

### 워커 모니터링 + LLM API 선택

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/lib/llm-api-monitoring.js` | ✅ |
| `node --check bots/worker/lib/ai-client.js` | ✅ |
| `node --check bots/worker/web/server.js` | ✅ |
| `node --check bots/worker/scripts/setup-worker.js` | ✅ |
| `cd bots/worker/web && npm run build` | ✅ |
| `node bots/worker/migrations/017-system-preferences.js` | ✅ |
| `node bots/worker/scripts/health-report.js --json` | ✅ |
| `curl -s http://127.0.0.1:4001/admin/monitoring` | ✅ |

### 투자 실행 모드 / 실패 원인 구조화 / 덱스터 경고 보정

| 테스트 | 결과 |
|--------|------|
| `node bots/investment/scripts/trading-journal.js --days=7` | ✅ |
| `node bots/investment/scripts/weekly-trade-review.js --dry-run` (실제 PostgreSQL 환경) | ✅ |
| `node bots/claude/scripts/health-report.js --json` | ✅ |

### 스카 shadow 비교 모델 + 운영 리뷰 입력 구조

| 테스트 | 결과 |
|--------|------|
| `python3 -m py_compile bots/ska/src/runtime_config.py bots/ska/src/forecast.py` | ✅ |
| `node --check scripts/reviews/daily-ops-report.js` | ✅ |
| `node --check scripts/reviews/ska-sales-forecast-daily-review.js` | ✅ |
| `node --check scripts/reviews/ska-sales-forecast-weekly-review.js` | ✅ |
| 스카 daily forecast 실행 | ✅ |
| `forecast_results.predictions.shadow_model_name = knn-shadow-v1` 저장 확인 | ✅ |
| `forecast_results.predictions.shadow_yhat / shadow_confidence` 저장 확인 | ✅ |

### 워커 문서 재사용 상세/성과 추적

| 테스트 | 결과 |
|--------|------|
| `cd bots/worker/web && npm run build` | ✅ |
| `/documents` 목록 빌드 | ✅ |
| `/documents/[id]` 상세 빌드 | ✅ |
| 문서 재사용 이력/성과 카드 렌더링 경로 빌드 | ✅ |

### 문서 체계 정리

| 테스트 | 결과 |
|--------|------|
| `SESSION_CONTEXT_INDEX.md`에서 새 문서 체계 링크 확인 | ✅ |
| `README.md` 문서 시작 순서 반영 확인 | ✅ |
| `PLATFORM_IMPLEMENTATION_TRACKER.md` rename 후 링크 경로 확인 | ✅ |

---

## 2026-03-08

### RAG 활용 완성 테스트 (커밋: 7630fc8)

| 테스트 | 항목 | 결과 |
|--------|------|------|
| A-1 | reporter.js → rag_operations 코드 존재 | ✅ |
| A-2 | doctor.js → rag_operations 코드 존재 | ✅ |
| A-3 | archer.js → rag_tech 코드 존재 | ✅ |
| A-4 | luna.js → rag_trades 코드 존재 | ✅ |
| A-5 | nightly git log → rag_tech | 🚫 의도적 제거 (아처와 중복) |
| B-1 | claude-lead-brain.js RAG 검색→LLM 프롬프트 주입 | ✅ |
| B-3 | claude-lead-brain.js shadow_log 후 RAG 저장 | ✅ |
| B-5 | luna.js RAG 검색→getSymbolDecision 프롬프트 주입 | ✅ |
| C-1 | Python 프로세스 0개 | ✅ |
| C-2 | 기존 plist 없음 | ✅ |
| C-3 | rag-system.deprecated 존재 | ✅ |
| C-4 | rag-server /health 응답 | ✅ |
| C-5 | 컬렉션 통계 (ops:1, trades:1, tech:1, docs:12) | ✅ |
| C-6 | system_docs 검색 정상 | ✅ |
| D-1 | 5개 파일 try-catch 보호 패턴 | ✅ |
| D-2 | 핵심 파일 5개 Node.js 문법 검사 | ✅ |
| D-3 | TP/SL OCO 안전장치 (luna, hephaestus) | ✅ |
| D-4 | archer.js RAG 삽입 순서 정상 | ✅ |
| E-1 | trades/ops/tech 실 저장·검색 동작 | ✅ |
| E-2 | operations 컬렉션 검색 응답 | ✅ |

**총계: 19/19 PASS (A-5 의도적 제외)**

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

---

## 2026-03-18

### 모바일 알림 최적화

| 테스트 | 결과 |
|--------|------|
| `node --check packages/core/lib/reporting-hub.js` | ✅ |
| `node --check packages/core/lib/telegram-sender.js` | ✅ |
| `node --check bots/orchestrator/lib/batch-formatter.js` | ✅ |
| `node --check bots/investment/shared/report.js` | ✅ |
| `node --check bots/investment/team/reporter.js` | ✅ |
| `node --check bots/investment/scripts/weekly-trade-review.js` | ✅ |
| `renderNoticeEvent/buildReportEvent` 모바일 샘플 출력 확인 | ✅ 헤더/구분선/디테일 축약 확인 |

### 투자 설정 실험 적용/검증

| 테스트 | 결과 |
|--------|------|
| `apply-runtime-config-suggestion.js --id=498d9f9c-4725-460a-a5ea-129e82f3be19 --write` | ✅ 실제 운영 `config.yaml` 반영 |
| `validate-runtime-config-apply.js --id=498d9f9c-4725-460a-a5ea-129e82f3be19 --days=7 --json` | ✅ `review_status=applied`, 판단 `observe` |
| `launchctl list | egrep 'ai\\.investment\\.commander'` | ✅ commander 재기동 확인 |

### 세션 종료 정합성

| 테스트 | 결과 |
|--------|------|
| 세션 문서 업데이트 (`SESSION_HANDOFF`, `WORK_HISTORY`, `RESEARCH_JOURNAL`, `CHANGELOG`) | ✅ |
| `node bots/claude/src/dexter.js --update-checksums` | ✅ 65개 파일 갱신 |

### 자동화 리포트 해석력 보강

| 테스트 | 결과 |
|--------|------|
| `node --check scripts/reviews/jay-llm-daily-review.js` | ✅ |
| `node --check packages/core/lib/health-runner.js` | ✅ |
| `node --check scripts/reviews/ska-sales-forecast-daily-review.js` | ✅ |
| `node --check scripts/reviews/daily-ops-report.js` | ✅ |
| `node scripts/reviews/jay-llm-daily-review.js --json` | ✅ `dbSourceStatus`에 `sandbox_restricted` 노출 확인 |
| `ls /Users/alexlee/projects/ai-agent-system/tmp/jay-llm-daily-review-db-snapshot.json` | ✅ 제이 DB snapshot fallback 파일 생성 확인 |
| `node scripts/reviews/jay-llm-daily-review.js --json` 재실행 | ✅ `dbSource=snapshot_fallback`, `dbSnapshotFallback=true` 확인 |
| `node scripts/reviews/ska-sales-forecast-daily-review.js --days=5 --json` | ✅ `requestedDays=5`, `effectiveDays=7` 확인 |
| `node scripts/reviews/daily-ops-report.js --json` | ✅ investment / reservation `localFallback.enabled=true` 확인 |
| `node scripts/reviews/daily-ops-report.js` | ✅ `보조 신호: local fallback 활동 신호 1건` 텍스트 출력 확인 |
| `node scripts/reviews/daily-ops-report.js --json` 재실행 | ✅ `sourceMode=unavailable(local teams) / local_fallback(investment,reservation) / auxiliary_review(global)` 확인 |
| `node scripts/reviews/daily-ops-report.js` 재실행 | ✅ active issue / input failure에 `sourceMode` 텍스트 출력 확인 |
