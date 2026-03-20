# 테스트 결과 이력

> Day별 테스트 통과/실패 누적 기록

---

## 2026-03-19

### 워커 재무 탭 확장 + 업체 비활성화 운영 완결

| 테스트 | 결과 |
|--------|------|
| `node bots/worker/migrations/020-expenses.js` | ✅ `worker.expenses` 테이블 추가 완료 |
| `node bots/worker/migrations/021-company-deactivation-meta.js` | ✅ `deactivated_reason`, `deactivated_by` 컬럼 실제 반영 확인 |
| `node bots/worker/scripts/import-expenses-from-excel.js "...2025년 스터디카페_고정지출관리_월별.xlsx" "...2026년 스터디카페_고정지출관리_월별.xlsx"` | ✅ 2025 파일 `126건 적재 / 2건 skip`, 2026 파일 `63건 적재 / 0건 skip`, 총 매입 `189건 / 47,427,532원` 확인 |
| `node --input-type=module ... worker.companies count` | ✅ 활성 업체 `4건`, 비활성 `0건`, 전체 `4건` 확인 |
| `node --input-type=module ... worker.companies active rows` | ✅ `sssssss`, `test-company`, `test_company`, `master` 활성 업체 조회 확인 |
| `node --check bots/worker/lib/expenses-ai.js` | ✅ |
| `node --check bots/worker/lib/expenses-import.js` | ✅ |
| `node --check bots/worker/scripts/import-expenses-from-excel.js` | ✅ |
| `node --check bots/worker/web/app/sales/page.js` | ✅ |
| `node --check bots/worker/web/app/admin/companies/page.js` | ✅ |
| `node --check bots/worker/web/server.js` | ✅ |
| `npm --prefix bots/worker/web run build` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ |
| `node bots/worker/scripts/health-report.js --json` | ✅ `web`, `nextjs`, `lead`, `task-runner`, API, websocket 정상 확인 |

### 워커 web 운영 화면 공용화 + 업무/일정/근태/매출 정리

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/web/components/PromptAdvisor.js` | ✅ |
| `node --check bots/worker/web/components/DataTable.js` | ✅ |
| `node --check bots/worker/web/lib/document-attachment.js` | ✅ |
| `node --check bots/worker/web/app/dashboard/page.js` | ✅ |
| `node --check bots/worker/web/app/work-journals/page.js` | ✅ |
| `node --check bots/worker/web/app/schedules/page.js` | ✅ |
| `node --check bots/worker/web/app/attendance/page.js` | ✅ |
| `node --check bots/worker/web/app/sales/page.js` | ✅ |
| `npm --prefix bots/worker/web run build` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ |
| `node bots/worker/scripts/health-report.js --json` | ✅ 프로세스(`web`, `nextjs`, `lead`, `task-runner`) 정상 확인. 재시작 직후 endpoint 경고는 warm-up 상태로 관측됨 |

### 워커 블로그 URL 입력의 발행일 경계 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/web/server.js` | ✅ |
| `node --input-type=module ... blog.posts 54/55 정규화 재현` | ✅ `54`, `55`가 `publishDate=2026-03-19`, `needsUrl=true`, `publishDue=true`로 계산됨 확인 |
| `npm --prefix bots/worker/web run build` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ |
| `node bots/worker/scripts/health-report.js --json` | ✅ `web`, `nextjs`, `lead`, `task-runner` 정상 확인 |

### 투자 validation 성과 반영 + 국내장 normal 2차 승격

| 테스트 | 결과 |
|--------|------|
| `node --check packages/core/lib/billing-guard.js` | ✅ |
| `node --input-type=module -e "import { isBlocked } from './packages/core/lib/billing-guard.js'; ..."` | ✅ 레거시 `investment` stop 파일 기준 `investment.normal=true`, `investment.validation=false` 확인 |
| `INVESTMENT_TRADE_MODE=validation node bots/investment/markets/domestic.js --force` | ✅ `214390 BUY 500000 자동 승인`, `최종 결과: 1개 신호 승인` 확인 |
| `node bots/investment/scripts/trading-journal.js --days=1` | ✅ `crypto VALIDATION: PAPER 2건`, `domestic VALIDATION: LIVE 1건`, `validation 승격 후보` 출력 확인 |
| `node bots/investment/scripts/weekly-trade-review.js --dry-run` | ✅ 세 시장 `NORMAL / VALIDATION` 통합 피드백 및 validation 후보 출력 확인 |
| `node --check bots/investment/scripts/runtime-config-suggestions.js` | ✅ |
| `node bots/investment/scripts/runtime-config-suggestions.js --days=7` | ✅ domestic validation `approved 1 / executed 1 / LIVE 1` 반영 및 `normal 승격 후보` 출력 확인 |
| `node --input-type=module -e "import { getInvestmentRuntimeConfig } from './bots/investment/shared/runtime-config.js'; ..."` | ✅ `stockStarterApproveDomestic=450000`, `stockStarterApproveOverseas=300` 확인 |

### blog / worker 상시 서비스 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/blog/api/node-server.js` | ✅ |
| `node --check bots/worker/src/worker-lead.js` | ✅ |
| `node --check bots/worker/src/task-runner.js` | ✅ |
| `node bots/blog/scripts/health-report.js --json` | ✅ `node-server`, `node-server API` 정상 확인 |
| `node bots/worker/scripts/health-report.js --json` | ✅ `lead`, `task-runner` 정상 확인 |

### 재부팅 절차 개편

| 테스트 | 결과 |
|--------|------|
| `bash -n scripts/pre-reboot.sh` | ✅ |
| `bash -n scripts/post-reboot.sh` | ✅ |
| `bash scripts/post-reboot.sh --dry-run` | ✅ 드라이런 종료, `/tmp/post-reboot-followup.txt` 생성 및 전사 launchd 점검 흐름 확인 |
| `tail -n 80 /tmp/post-reboot.log` | ✅ 현재 로컬 상태 기준 `OK 5 / WARN 16 / FAIL 12`로 보고, 후속 `health-report --json` 재확인 필요 메시지 확인 |

### 루나 퍼널 계측 + 바이낸스 보수성 조정

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/shared/pipeline-decision-runner.js` | ✅ |
| `node --check bots/investment/team/luna.js` | ✅ |
| `node --check bots/investment/scripts/trading-journal.js` | ✅ |
| `node --check bots/investment/scripts/weekly-trade-review.js` | ✅ |
| `node --input-type=module -e "...getLunaRuntimeConfig(), getLunaParams()..."` | ✅ `binance live minConfidence=0.44`, `crypto debate=0.56/0.18`, `fastPath minCryptoConfidence=0.40` 확인 |
| `node bots/investment/scripts/trading-journal.js --days=1` | ✅ `decision 퍼널 병목` 섹션에 시장별 `BUY / SELL / HOLD / executed / weak / risk / saved` 출력 확인 |
| `node bots/investment/scripts/weekly-trade-review.js --dry-run` | ✅ `의사결정 퍼널 병목` 섹션에 시장별 `BUY / SELL / HOLD / executed / weak / risk / saved` 출력 확인 |

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
| `plutil -lint bots/investment/launchd/ai.investment.crypto.plist` | ✅ OK |
| `plutil -lint bots/investment/launchd/ai.investment.crypto.validation.plist` | ✅ OK |
| `bash -n scripts/pre-reboot.sh` | ✅ 통과 |
| `bash -n scripts/post-reboot.sh` | ✅ 통과 |
| `node --check bots/investment/shared/capital-manager.js` | ✅ 통과 |
| `node --check bots/investment/team/nemesis.js` | ✅ 통과 |
| `node --input-type=module -e "import { getCapitalConfig } from './bots/investment/shared/capital-manager.js'; ..."` | ✅ normal 바이낸스 정책 `reserve_ratio=0.02`, `max_position_pct=0.18`, `max_concurrent_positions=6`, `max_daily_trades=16` 확인 |
| `INVESTMENT_TRADE_MODE=validation node --input-type=module -e "import { getCapitalConfig } from './bots/investment/shared/capital-manager.js'; ..."` | ✅ validation 바이낸스 정책 `reserve_ratio=0.01`, `risk_per_trade=0.01`, `max_position_pct=0.08`, `max_concurrent_positions=3`, `max_daily_trades=8` 확인 |
| `node --check bots/investment/shared/db.js` | ✅ 통과 |
| `node --check bots/investment/shared/trade-journal-db.js` | ✅ 통과 |
| `node --check bots/investment/shared/pipeline-decision-runner.js` | ✅ 통과 |
| `node --check bots/investment/scripts/trading-journal.js` | ✅ 통과 |
| `node --check bots/investment/scripts/weekly-trade-review.js` | ✅ 통과 |
| `node bots/investment/scripts/trading-journal.js --days=1` | ✅ `trade_journal.trade_mode` 마이그레이션 선행 후 `[LIVE][NORMAL]`, `[PAPER][NORMAL]` 태그와 `mode NORMAL` 퍼널 출력 확인 |
| `node bots/investment/scripts/weekly-trade-review.js --dry-run` | ✅ 주간 퍼널에 `mode NORMAL ...` 운영모드 집계 출력 확인 |
| `node --check bots/investment/markets/crypto.js` | ✅ `trade_mode`별 상태 파일 분리 로직 문법 확인 |
| `plutil -lint bots/investment/launchd/ai.investment.domestic.validation.plist` | ✅ OK |
| `plutil -lint bots/investment/launchd/ai.investment.overseas.validation.plist` | ✅ OK |

### 워커 매출 / 스카 동기화 및 페이지네이션 정리

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/lib/ska-sales-sync.js` | ✅ 통과 |
| `node --check bots/worker/web/server.js` | ✅ 통과 |
| `node --check bots/worker/web/app/sales/page.js` | ✅ 통과 |
| `node --check bots/worker/web/components/DataTable.js` | ✅ 통과 |
| `node -e "syncSkaSalesToWorker('test-company')"` 1차 실행 | ✅ 누락분 `inserted: 124` backfill 확인 |
| `node --input-type=module -e "... worker.sales / reservation.daily_summary 총액 대조 ..."` | ✅ `28,847,500원`, 최신일 `2026-03-19` 일치 확인 |
| `PICKKO_HEADLESS=1 node bots/reservation/scripts/pickko-revenue-backfill.js --from=2026-03 --to=2026-03` | ✅ `2026-03-16~2026-03-18` 원천 데이터 복구 확인, 종료 시 CSV export `rows is not iterable` 잔여 오류 확인 |
| `node --input-type=module -e "... 2026-03-16~2026-03-19 daily_summary 확인 ..."` | ✅ `pickko_total/general_revenue` 기준 저장 확인 |
| `node --input-type=module -e "... 2026-01-01~2026-01-12 worker.sales 확인 ..."` | ✅ `test-company`의 1월 초 데이터가 이미 존재함을 확인 |
| `node -e "... daily_summary vs worker.sales mismatch check ..."` | ✅ `2026-03-19` 1건 mismatch 확인 후 `mismatchCount: 0`으로 재검증 완료 |
| `node -e "... room_amounts_json 있는데 pickko_study_room=0 인 날짜 탐지 ..."` | ✅ 이상치 37건 확인 |
| `node -e "... daily_summary pickko_study_room / pickko_total 원천 보정 ..."` | ✅ 원천 37건 복구 완료 |
| `node -e "syncSkaSalesToWorker('test-company')"` 2차 실행 | ✅ room JSON 기반 스터디룸 매출 `inserted: 37`, 최종 `expectedRows: 274` 확인 |
| `node -e "... room_amounts_json 기준 suspicious 재검사 ..."` | ✅ `suspiciousCount: 0` |
| `node --check bots/reservation/lib/db.js` | ✅ 통과 |
| `node --check bots/reservation/auto/scheduled/pickko-daily-summary.js` | ✅ 통과 |
| `npm --prefix bots/worker/web run build` | ✅ 통과 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ 실행 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ 실행 |
