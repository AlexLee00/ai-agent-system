# 작업 히스토리

> 날짜별 타임라인. "지난 주에 뭐 했지?" 빠른 파악용.
> 상세 내용: `reservation-dev-summary.md` / `reservation-handoff.md`
> 최초 작성: 2026-02-27

### 12주차 후속 (2026-03-20) — 아처 자동화 리포트 재검증 + 비용 표 source 보정

핵심 구현:
- `bots/claude/lib/archer/analyzer.js`
  - 최근 7일 비용 표 source를 `claude.billing_snapshots`에서 `reservation.llm_usage_log` 일별 합계로 교체
  - 월 누적 비용과 소진율은 기존처럼 `billing_snapshots` provider별 최신값을 유지
  - 날짜 라벨을 `YYYY-MM-DD` 형식으로 정규화
- `bots/claude/reports/archer-2026-03-20.md`
  - 수정된 로직 기준으로 리포트를 재생성

세션 맥락:
- 아처 최신 리포트를 다시 생성해 보니 월 누적 비용은 정상화됐지만, 최근 7일 비용 표가 모두 `0.000`으로 보여 추가 점검이 필요했다.
- `billing_snapshots`를 직접 확인한 결과, 이 테이블은 외부 billing API의 월 누적 snapshot을 일별로 저장하고 있었고 최근 10일 값이 provider별로 동일했다.
- 반면 `reservation.llm_usage_log`의 실제 일별 사용량은 날짜별로 변동이 있어, 최근 7일 비용 표는 usage log를 source로 쓰는 것이 더 정확하다고 판단했다.

의사결정 이유:
- 월 누적 비용/소진율은 외부 billing API snapshot이 정합성이 높지만, 운영자가 보는 일별 트렌드 표는 실사용 로그 기반이 더 해석 가능성이 높다.
- 즉 비용 리포트는 `월 누적 = billing snapshot`, `일별 추세 = usage log`로 source를 분리하는 것이 맞다.

### 12주차 후속 (2026-03-20) — 비디오팀 handoff 정합화 + 코덱 세션 시작/마감 규칙 반영

핵심 구현:
- `docs/SESSION_HANDOFF.md`
  - 비디오팀 세션 컨텍스트를 현재 상태 기준으로 갱신
  - `CLAUDE.md`, `samples/ANALYSIS.md` 링크를 추가하고 `scripts` 폴더 상태를 예약 폴더 기준으로 수정
  - 전사 handoff의 `반드시 먼저 읽기` 순서에 `SESSION_HANDOFF.md` 자체를 다시 포함
  - 코덱이 세션 시작 시 문서 묶음을 먼저 읽고, 세션 마감 직전 `SESSION_HANDOFF / WORK_HISTORY / CHANGELOG / TEST_RESULTS` 갱신 여부를 확인하도록 규칙 명시
- `docs/SESSION_CONTEXT_INDEX.md`
  - 코덱 세션은 시작과 종료 모두 handoff 규칙을 따르도록 문구 추가
  - 종료 시 문서 갱신 체크리스트를 유지 규칙에 반영

세션 맥락:
- 비디오팀 문서 묶음은 최근 정리됐지만, 전사 `SESSION_HANDOFF.md`의 비디오팀 섹션은 아직 `scripts 제거` 같은 예전 상태를 가리키고 있었다.
- 동시에 코덱이 세션 시작과 마감에 인수인계 문서를 반드시 읽도록 운영 규칙을 문서로 고정할 필요가 있었다.

의사결정 이유:
- 내부 MVP와 이후 SaaS 확장을 모두 고려하면, 새로운 팀 폴더를 추가할 때 전사 handoff와 팀 handoff가 같은 상태를 가리켜야 다음 세션 복원 비용이 줄어든다.
- 코덱 세션의 시작/마감 규칙은 자동 실행보다 먼저 문서 규칙으로 고정해야 운영 누락을 줄일 수 있다.
- 다만 Codex 앱 레벨에서 실제 자동 강제를 걸려면 리포지토리 루트 `AGENTS.md` 같은 물리적 지시 파일이 추가로 필요하다.

### 12주차 후속 (2026-03-20) — 어제자 리포트 후속: KIS 과속 완화 + 아처 비용 표 왜곡 수정

핵심 구현:
- `bots/investment/shared/kis-client.js`
  - KIS 공용 요청 함수 `kisRequest()`에 최소 호출 간격(`380ms`)과 `paper/live` 별도 직렬화 queue를 추가
  - `초당 거래건수를 초과하였습니다.` 또는 `rate limit` 응답은 최대 2회 backoff 재시도하도록 정리
- `bots/claude/lib/archer/analyzer.js`
  - `billing_snapshots`가 월 누적 snapshot임을 반영해 최근 7일 표를 day-over-day delta로 계산하도록 수정
  - 월간 누적/소진율은 `SUM(cost_usd)`가 아니라 provider별 최신 snapshot을 합산하도록 보정

세션 맥락:
- 어제자 아처 리포트와 투자 로그를 확인한 결과, 국내주식 쪽에서는 `KIS API 오류 [undefined]: 초당 거래건수를 초과하였습니다.`가 실제로 반복되고 있었다.
- 동시에 아처 주간 리포트의 LLM 비용 트렌드는 최근 7일이 모두 동일한 비용처럼 보였는데, 이는 live 비용 패턴이라기보다 누적 snapshot 해석 오류로 판단됐다.

의사결정 이유:
- KIS 과속은 한울 한 곳만 늦추는 임시 대응보다 공용 요청 레이어에서 전체 국내 호출을 보호하는 편이 더 안정적이다.
- 비용 리포트는 운영 판단의 근거이므로, 저장 구조(`billing_snapshots = 월 누적`)와 표시 구조(일별 비용 표)가 정확히 일치해야 한다.
- 루나 guard는 현재 health 기준으로 active guard가 없으므로, 오늘 우선 수정은 현재 장애성이 있는 KIS와 비용 정합성에 집중하는 것이 맞았다.

검증:
- `node --check bots/investment/shared/kis-client.js`
- `node --check bots/claude/lib/archer/analyzer.js`
- `launchctl list | egrep 'ai\.investment\.(commander|crypto|domestic|overseas|reporter)'`
- `tail -n 120 /tmp/investment-domestic.err.log`
- `tail -n 120 /tmp/investment-domestic.log`
- `node bots/investment/scripts/health-report.js --json`

### 12주차 후속 (2026-03-20) — 모바일 알림 제목 축약 + 스카 모니터 리로드 안정화

핵심 구현:
- `packages/core/lib/reporting-hub.js`
  - 공용 `compactNoticeTitle()`에 모바일 short-title 축약 규칙 추가
  - `루나 메트릭 경고`, `오늘 예약 현황`, `국내주식 수집`, `해외주식 수집` 계열 제목을 짧게 정리
- `bots/investment/shared/pipeline-market-runner.js`
  - `summarizeCollectWarnings()`, `buildCollectAlertMessage()` 추가
  - 루나 collect 경고를 raw key 나열 대신 `LLM guard 발동`, `보조 분석 수집 차단`, `핵심 수집 정상` 의미로 풀어 쓰도록 보강
- `bots/investment/markets/crypto.js`, `domestic.js`, `overseas.js`
  - 새 경고 본문 생성 helper를 사용하도록 정리
- `bots/orchestrator/n8n/setup-ska-workflows.js`
  - `스카팀 일간 매출 요약 (n8n)` → `스카 매출 요약`
  - `스카팀 주간 매출 트렌드 (n8n)` → `스카 주간 매출`
  - 워크플로우 재설치 및 활성화
- `bots/reservation/auto/scheduled/pickko-daily-summary.js`
  - `오늘 예약 현황 — ...` → `오늘 예약 · ...`
- `bots/reservation/auto/monitors/naver-monitor.js`
  - heartbeat 제목을 `오늘 예약 (...)` 형태로 축약
- `bots/reservation/scripts/reload-monitor.sh`
  - 무조건 `bootout/bootstrap`을 반복하지 않고, launchd 등록 상태를 확인한 뒤 필요할 때만 `bootstrap`
  - 재시작은 `kickstart -k` 중심으로 단순화

세션 맥락:
- 사용자는 모바일 텔레그램 카드에서 제목이 2줄로 꺾여 운영 가독성이 떨어진다고 지적했고, 스카 모니터 재기동도 `Bootstrap failed: 5`로 불안정하다고 보고했다.
- 특히 `/ops-health` 경고와 스카 매출/예약 알림은 첫 줄만 보고도 의미를 파악할 수 있어야 한다는 운영 요구가 강했다.

의사결정 이유:
- 내부 MVP 운영에서는 알림의 정보량보다 **모바일 첫 줄 스캔 속도**가 더 중요하므로, 같은 의미를 유지하면서 short-title로 축약하는 편이 맞다.
- 루나 collect 경고는 핵심 수집 장애와 보조 enrichment 실패를 구분해서 보여야 운영자가 과잉 대응하지 않는다.
- 스카 모니터는 이미 launchd에 등록된 서비스를 매번 강제 재등록할 필요가 없으므로, `ensure_launchd_service + kickstart -k`가 더 안전하다.

검증:
- `node --check packages/core/lib/reporting-hub.js`
- `node --check bots/investment/shared/pipeline-market-runner.js`
- `node --check bots/investment/markets/crypto.js`
- `node --check bots/investment/markets/domestic.js`
- `node --check bots/investment/markets/overseas.js`
- `node --check bots/orchestrator/n8n/setup-ska-workflows.js`
- `node --check bots/reservation/auto/scheduled/pickko-daily-summary.js`
- `node --check bots/reservation/auto/monitors/naver-monitor.js`
- `bash -n bots/reservation/scripts/reload-monitor.sh`
- `node bots/orchestrator/n8n/setup-ska-workflows.js`
- `bash bots/reservation/scripts/reload-monitor.sh`

### 12주차 후속 (2026-03-20) — 루나 LLM guard 범위 정밀화 + TTL 자동 해제

핵심 구현:
- `bots/investment/shared/pipeline-market-runner.js`
  - collect 경고 본문 helper에서 footer를 제거해 `조치: 상세 내용 확인`, `추가 점검: /ops-health`가 카드에 중복 출력되지 않도록 정리
- `packages/core/lib/billing-guard.js`
  - `investment.normal.crypto`, `investment.normal.domestic`, `investment.normal.overseas` 같은 투자 market/symbol scope를 정확히 해석하도록 보강
  - 투자 guard 자동 만료(TTL) 추가
    - market-level: 30분
    - symbol-level: 15분
  - 만료된 investment guard는 읽기 시점에 자동 삭제
- `packages/core/lib/llm-logger.js`
  - `llm_usage_log`에 `market`, `symbol`, `guard_scope` 컬럼 추가
  - 투자 심볼 호출은 팀 전체가 아니라 심볼 기준 10분 급등으로 우선 감지
  - `llm-logger`가 생성한 investment guard는 scope에 따라 자동 만료 시각을 함께 기록
- `bots/investment/shared/llm-client.js`
  - `callLLM()`가 `market`, `symbol`, `guardScope`를 계산해 로깅과 guard 체크에 함께 넘기도록 보강
- `bots/investment/shared/secrets.js`
  - `INVESTMENT_MARKET` 환경변수를 읽어 market-level guard scope를 안정적으로 계산
- `bots/investment/markets/crypto.js`, `domestic.js`, `overseas.js`
  - 각 수집 프로세스가 `INVESTMENT_MARKET=crypto|domestic|overseas`를 명시하도록 정리
- `bots/investment/team/athena.js`, `oracle.js`, `hermes.js`, `sophia.js`, `nemesis.js`, `luna.js`
  - per-symbol LLM 호출에 심볼 문맥을 넘겨 symbol-aware guard와 실제로 연결

세션 맥락:
- 사용자는 `collect_blocked_by_llm_guard`, `enrichment_collect_failure_rate_high` 경고가 핵심 수집 장애처럼 보이는지, 차단이 너무 엄격한지, 비용 이슈인지 분석을 요청했다.
- 코덱이 로그를 확인한 결과, 핵심 수집은 정상(`coreFailed=0`)이고 `L03/L04/L05` enrichment만 LLM guard로 막히는 구조였으며, 기존 broad guard가 국내/해외까지 번지는 문제가 있었다.

의사결정 이유:
- 내부 MVP에서는 guard 자체를 없애는 것보다, **범위를 global -> market -> symbol로 좁혀 false-positive 운영 피로를 줄이는 것**이 더 안전하다.
- 비용 초과 guard가 아니라 리스크 guard이므로 완전 해제보다 자동 만료(TTL)와 scope 정밀화가 우선이다.
- `llm_usage_log`에 market/symbol/guard_scope를 남겨야 향후 `/ops-health`, audit, SaaS형 guard policy로 확장하기 쉽다.

검증:
- `node --check bots/investment/shared/pipeline-market-runner.js`
- `node --check packages/core/lib/billing-guard.js`
- `node --check packages/core/lib/llm-logger.js`
- `node --check bots/investment/shared/llm-client.js`
- `node --check bots/investment/shared/secrets.js`
- `node --check bots/investment/markets/crypto.js`
- `node --check bots/investment/markets/domestic.js`
- `node --check bots/investment/markets/overseas.js`
- `node --check bots/investment/team/athena.js`
- `node --check bots/investment/team/oracle.js`
- `node --check bots/investment/team/hermes.js`
- `node --check bots/investment/team/sophia.js`
- `node --check bots/investment/team/nemesis.js`
- `node --check bots/investment/team/luna.js`
- `node bots/investment/scripts/health-report.js --json`
- `node --input-type=module -e "import { getBlockReason } from './packages/core/lib/billing-guard.js'; ..."`

### 12주차 후속 (2026-03-20) — /ops-health 루나 guard 범위·만료 시각 표시

핵심 구현:
- `packages/core/lib/billing-guard.js`
  - active stop 파일을 scope prefix 기준으로 조회하는 `listActiveGuards()` helper 추가
  - 오케스트레이터 `/ops-health`와 루나 health-report가 같은 guard source를 읽도록 정리
- `bots/orchestrator/lib/night-handler.js`
  - `getLunaRiskSnapshot()`에 투자 `LLM guard` 활성 상태를 포함
  - active guard가 있으면
    - `암호화폐/국내주식/해외주식` 범위
    - 자동 해제 시각
    - 차단 사유
    를 리스크 라인에 함께 표시
- `bots/investment/scripts/health-report.js`
  - `guardHealth` 섹션 추가
  - `투자 LLM guard 없음` 또는 `시장별 차단 / 자동 해제 시각`을 직접 표시
  - 운영 판단에도 `투자 LLM guard n건 활성`을 medium 경고로 반영

세션 맥락:
- 사용자는 `/ops-health`에서 guard가 왜 걸렸는지, 범위가 어디까지인지, 언제 풀리는지를 한눈에 보고 싶어 했다.
- 코덱은 기존 broad stop/TTL 작업을 마친 뒤, 현재 상태와 다음 단계의 경계를 분리해서 “표시 레이어만 추가”하는 보수적 확장으로 붙였다.

의사결정 이유:
- 지금 당장 필요한 구조는 guard dashboard 신설이 아니라, 기존 `/ops-health`와 `루나 운영 헬스`가 같은 guard state를 읽어 운영 가시성을 높이는 것이다.
- 공용 `billing-guard`를 source of truth로 두면 이후 멀티워크스페이스 SaaS에서도 guard 상태를 같은 방식으로 재사용할 수 있다.

검증:
- `node --check packages/core/lib/billing-guard.js`
- `node --check bots/orchestrator/lib/night-handler.js`
- `node --check bots/investment/scripts/health-report.js`
- `node bots/investment/scripts/health-report.js --json`
- `node bots/orchestrator/scripts/health-report.js --json`
- `launchctl kickstart -k gui/$(id -u)/ai.orchestrator`

추가 보정:
- `bots/orchestrator/src/router.js`
  - 통합 운영 헬스 요약에서 루나 행에 `guard n건`을 함께 보여주도록 정리
- `bots/orchestrator/lib/night-handler.js`, `bots/investment/scripts/health-report.js`
  - `expires_at` 표기를 `YYYY-MM-DD HH:MM` KST 형식으로 축약해 모바일/운영 화면에서 더 짧게 읽히도록 정리
  - guard 본문은 `범위/해제 시각`을 먼저 두고, 원인은 `사유:` 한 줄 보조 정보로 압축

### 12주차 후속 (2026-03-20) — 일간 매매 한도 차단 문구 명확화

핵심 구현:
- `bots/investment/shared/capital-manager.js`
  - 공용 helper `formatDailyTradeLimitReason()` 추가
  - `일간 매매 한도: 10/8` 형태의 모호한 표현을
    - `일간 매매 한도 초과: 현재 10건 / 한도 8건`
    - `일간 매매 한도 도달: 현재 8건 / 한도 8건`
    형태로 명확하게 정리
- `bots/investment/team/hephaestos.js`
  - 실제 실행 단계의 skip/failure 사유도 같은 공용 helper를 사용하도록 통일

의사결정 이유:
- 운영 알림은 차단 여부뿐 아니라 현재치와 한도를 즉시 읽을 수 있어야 한다.
- 동일 사유를 사전 자본관리와 실행 단계에서 각자 문자열로 만들면 표현이 다시 어긋날 수 있으므로 공용 helper로 묶는 편이 안전하다.

검증:
- `node --check bots/investment/shared/capital-manager.js`
- `node --check bots/investment/team/hephaestos.js`
- `node --input-type=module -e "import { formatDailyTradeLimitReason } from './bots/investment/shared/capital-manager.js'; ..."`

### 12주차 후속 (2026-03-20) — 루나 알림 카드 구분선 10칸 축소

핵심 구현:
- `bots/investment/shared/report.js`
  - 루나 공용 카드 템플릿의 `DIVIDER`, `SMALL_DIVIDER`를 `15칸`에서 `10칸`으로 축소

의사결정 이유:
- 모바일 텔레그램 카드에서 긴 구분선은 제목/사유 줄바꿈을 더 쉽게 유발하므로, 장식 요소 폭을 줄여 카드 폭 체감을 완화하는 편이 운영 UX에 유리하다.

검증:
- `node --check bots/investment/shared/report.js`
- `node --input-type=module -e "import { readFileSync } from 'fs'; ..."` 로 divider 길이 `10` 확인

### 12주차 후속 (2026-03-19) — 워커 재무 탭 확장 + 업체 비활성화 운영 완결

핵심 구현:
- `bots/worker/migrations/020-expenses.sql`, `020-expenses.js`
  - `worker.expenses` 원장 테이블 추가
- `bots/worker/lib/expenses-ai.js`, `expenses-import.js`
  - 매입 제안 파서와 `매입내역` 시트 import 로직 추가
- `bots/worker/scripts/import-expenses-from-excel.js`
  - 2025/2026 스터디카페 고정지출 엑셀을 `worker.expenses`로 적재하는 재실행 스크립트 추가
- `bots/worker/web/server.js`
  - `expenses` CRUD / summary / proposal / confirm / reject / import API 추가
  - `sales/summary`, `expenses/summary`에 `currentYear` 집계 추가
  - `companies` soft delete 운영용 `status` 필터, `restore`, `activity` API 추가
- `bots/worker/web/app/sales/page.js`
  - `매출 | 매입 | 손익` 탭 구조 도입
  - 손익 탭은 읽기 전용 `손익 브리핑` + 손익 구조 / 월별 비교 중심으로 정리
- `bots/worker/web/app/admin/companies/page.js`
  - `비활성화` 모달
  - 상태 필터
  - 복구 버튼
  - 비활성화 사유 / 처리자 컬럼
  - 최근 업체 상태 변경 이력 카드 추가
- `bots/worker/lib/ska-sales-sync.js`
  - 스카 `daily_summary`와 `test-company` 워커 매출 미러 정합성 유지

세션 맥락:
- 사용자는 매출관리 안에서 매입과 손익까지 같이 보고 싶다고 요청했고, 별도 페이지가 아니라 기존 매출관리의 확장 구조를 원했다.
- 또한 업체 삭제의 실제 의미가 완전 삭제가 아니라 비활성화라는 점을 운영 화면에서도 정확히 보이게 해달라고 요청했다.

의사결정 이유:
- 내부 MVP 기준으로는 새로운 재무 페이지를 만드는 것보다, 기존 `sales/page.js`를 `매출 | 매입 | 손익` 탭으로 확장하는 것이 가장 빠르고 안정적이다.
- 매입 원장은 엑셀 `매입내역` 시트를 source of truth로 두는 것이 월별 집계표보다 추후 검증/로그/중복 방지 구조에 유리하다.
- 업체는 하위 데이터 루트 엔티티이므로 soft delete가 맞고, 비활성화/복구/사유/처리자/이력까지 갖춰야 운영 정책이 닫힌다.

검증:
- `node bots/worker/migrations/020-expenses.js`
- `node bots/worker/migrations/021-company-deactivation-meta.js`
- `node bots/worker/scripts/import-expenses-from-excel.js "...2025년 스터디카페_고정지출관리_월별.xlsx" "...2026년 스터디카페_고정지출관리_월별.xlsx"`
- `node --check bots/worker/web/app/sales/page.js`
- `node --check bots/worker/web/app/admin/companies/page.js`
- `node --check bots/worker/web/server.js`
- `npm --prefix bots/worker/web run build`
- `launchctl kickstart -k gui/$(id -u)/ai.worker.web`
- `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs`
- `node bots/worker/scripts/health-report.js --json`

### 12주차 후속 (2026-03-19) — 워커 web 운영 화면 공용화 + 업무/일정/근태/매출 정리

핵심 구현:
- `bots/worker/web/components/PromptAdvisor.js`
  - 드래그 앤 드롭 파일 첨부 지원
  - 드롭 중 중앙 사각형 `+` 오버레이 추가
  - 안내 문구 제거로 입력 밀도 정리
- `bots/worker/web/lib/document-attachment.js`
  - 첨부 문서 문맥을 제출 시점에만 합성하는 `mergePromptWithDocumentContext()` 추가
  - 업로드 notice를 `프롬프트에 첨부`가 아니라 `제출 시 결과에 반영` 의미로 수정
- `bots/worker/web/app/dashboard/page.js`
  - 첨부 문맥 분리
  - 첨부파일만 있어도 제출 가능하도록 보강
- `bots/worker/web/app/work-journals/page.js`
  - `/work-journals`를 정식 업무관리 경로로 사용
  - 첨부 문맥 분리
  - `일일업무` 카테고리 통합
  - 필터 + 리스트 카드 통합
  - 검색창을 돋보기 토글 방식으로 전환
  - `+ 수동 등록` 버튼을 필터 줄 우측 정렬로 배치
- `bots/worker/web/app/schedules/page.js`
  - 월 이동 줄 좌측 정렬
  - `캘린더 | 목록` 줄 우측에 `+ 수동 등록`
  - 첨부 문맥 분리
  - proposal이 없을 때 빈 승인 박스가 뜨지 않도록 정리
  - 완료 notice 전용 카드 보강
- `bots/worker/web/app/attendance/page.js`
  - 상단 탭/날짜 필터를 한 줄 도구바로 재정렬
  - 데스크톱에서 `시작날짜 / 종료날짜`가 2줄로 꺾이지 않도록 `nowrap` 기준 보강
- `bots/worker/web/app/sales/page.js`
  - 구형 자연어 입력 카드 제거
  - `PromptAdvisor` 전환
  - 첨부 문맥 분리 / 첨부-only 제출 허용
  - `매출 운영 요약` + `목록/차트/+ 매출 등록` 통합 카드 구성
- `bots/worker/web/components/DataTable.js`
  - PC 테이블 셀 수직 정렬을 `align-middle`로 통일

세션 맥락:
- 대시보드, 근태관리, 일정관리, 업무관리 1차 정리 후 남아 있던 공용 UX 불일치와 매출관리 구형 입력 패턴을 정리했다.
- 특히 첨부 문서 파싱 결과가 프롬프트 본문에 직접 섞이던 구조를 모든 핵심 운영 페이지에서 분리해, 사용자 입력과 시스템 보조 문맥의 경계를 회복했다.

의사결정 이유:
- 내부 MVP 단계에서도 운영 화면은 실제 사용자가 빠르게 읽고 입력할 수 있어야 하므로, 입력형/검토형/조회형 역할을 명확히 나누는 것이 중요하다.
- 첨부 문맥을 프롬프트 본문에서 분리하면 로그/피드백 구조가 더 명확해지고, 이후 멀티워크스페이스 SaaS에서 사용자 입력/시스템 보조 문맥/첨부 이력을 각각 추적하기 쉬워진다.
- 업무/일정/근태/매출 화면이 같은 공용 패턴을 쓰면 추후 운영 콘솔 확장과 반응형 보정도 훨씬 안정적으로 진행할 수 있다.

검증:
- `node --check bots/worker/web/components/PromptAdvisor.js`
- `node --check bots/worker/web/components/DataTable.js`
- `node --check bots/worker/web/app/dashboard/page.js`
- `node --check bots/worker/web/app/work-journals/page.js`
- `node --check bots/worker/web/app/schedules/page.js`
- `node --check bots/worker/web/app/attendance/page.js`
- `node --check bots/worker/web/app/sales/page.js`
- `npm --prefix bots/worker/web run build`
- `launchctl kickstart -k gui/$(id -u)/ai.worker.web`
- `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs`
- `node bots/worker/scripts/health-report.js --json`

### 12주차 후속 (2026-03-19) — 워커 블로그 URL 입력의 발행일 경계 복구

핵심 구현:
- `bots/worker/web/server.js`
  - `buildBlogPublishedUrlPayload()`가 `publish_date`를 함께 조회
  - `ready + publish_date <= 오늘(KST) + URL 미입력` 글을 `needs_url`로 승격
  - `publish_due` 상태를 추가해 오늘 발행 확인 대상과 미래 예약 글을 구분
  - PostgreSQL `Date` 객체를 `String(date)`로 비교하면서 `Thu Mar 19` 형태가 되어 분류가 깨지던 버그를 수정
  - 이제 KST 기준 `YYYY-MM-DD` 문자열로 정규화해 비교
- `bots/worker/web/app/admin/monitoring/blog-links/page.js`
  - 카드/요약 문구를 새 기준에 맞게 수정
  - `발행일`, `발행 확인 필요` 상태를 함께 노출

세션 맥락:
- 운영 화면에서 “어제 등록되어 오늘 오전 발행 예정인 글”이 여전히 `발행예정`에 남아 있어, 실제 발행 확인과 URL 후처리 타이밍이 한 박자 늦어지는 문제가 있었다.

의사결정 이유:
- 블로그 URL 입력은 단순 상태 표시가 아니라 내부 링크와 발행 후처리 기준점이므로, `status`만이 아니라 실제 `publish_date`를 함께 해석해야 운영 정확도가 높다.
- 내부 MVP 기준으로는 새 상태 테이블을 만드는 대신 기존 `blog.posts.publish_date`를 재활용하는 것이 가장 빠르고 안전하다.

검증:
- `node --check bots/worker/web/server.js`
- `npm --prefix bots/worker/web run build`
- `launchctl kickstart -k gui/$(id -u)/ai.worker.web`
- `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs`
- `node bots/worker/scripts/health-report.js --json`

### 12주차 후속 (2026-03-19) — 투자 validation 성과 확인 + 국내장 normal 2차 승격

핵심 구현:
- `billing-guard.js`에서 레거시 `investment` stop 파일이 `investment.normal`만 차단하고 `investment.validation`까지 전염되지 않도록 수정
- 국내장 validation 강제 세션이 `LLM 긴급 차단 fallback`이 아닌 정상 분석/판단 경로로 진입하도록 복구
  - `214390 BUY 500000 자동 승인`
  - `최종 결과: 1개 신호 승인`
- `runtime-config-suggestions.js`가 validation 실제 체결 데이터를 우선 반영하도록 보강
  - `executed = max(meta.executed, tradeTotal)`
  - `approved = max(meta.approved, executed)`
- 국내장 validation 성과를 근거로 normal 정책을 제한 승격
  - `stockStarterApproveDomestic: 400000 -> 450000`

세션 맥락:
- 사용자는 국내장/국외장도 거래 시간이 짧으므로 validation을 넓게 적용하고, 거래가 먼저 발생해야 후속 판단이 가능하다고 명시했다.
- 그에 따라 세 시장 validation을 공용 구조로 확장했고, 이번 라운드에서는 국내장 validation이 실제 승인/체결 성과를 낸 것을 normal 정책에 반영하는 단계까지 진행됐다.

의사결정 이유:
- validation은 이제 단순 canary가 아니라 실제 정책 승격 후보를 만드는 레일로 기능한다.
- 국내장 validation에서 실제 `LIVE 1건`이 확인된 만큼, 전면 완화보다 `starter approve` 한도만 소폭 올리는 제한 승격이 내부 MVP와 운영 안정성에 가장 적합했다.

검증:
- `INVESTMENT_TRADE_MODE=validation node bots/investment/markets/domestic.js --force`
- `node bots/investment/scripts/trading-journal.js --days=1`
- `node bots/investment/scripts/weekly-trade-review.js --dry-run`
- `node bots/investment/scripts/runtime-config-suggestions.js --days=7`

### 12주차 후속 (2026-03-19) — blog / worker 상시 서비스 복구

핵심 구현:
- launchd에서 빠져 있던 상시 서비스 3개를 재등록/재기동
  - `ai.blog.node-server`
  - `ai.worker.lead`
  - `ai.worker.task-runner`
- 팀 health-report 기준 모두 정상 상태 회복
  - blog: `node-server`, `node-server API`
  - worker: `lead`, `task-runner`

세션 맥락:
- 전사 오류 로그 점검 결과 실제 운영 공백은 투자보다 `blog node-server`, `worker lead/task-runner` 미로드가 더 직접적이었다.
- 셋 다 optional 서비스가 아니라 문서/health 기준상 상시 서비스였고, 코드 자체보다 launchd 미로드가 핵심 원인으로 확인됐다.

의사결정 이유:
- 내부 MVP 운영에서는 신규 기능보다 상시 서비스 복구가 우선이다.
- `launchctl list`의 종료 코드보다 `launchctl print + health-report`를 최종 기준으로 삼는 편이 운영 판단 정확도가 높다.

검증:
- `node --check bots/blog/api/node-server.js`
- `node --check bots/worker/src/worker-lead.js`
- `node --check bots/worker/src/task-runner.js`
- `node bots/blog/scripts/health-report.js --json`
- `node bots/worker/scripts/health-report.js --json`

### 12주차 후속 (2026-03-19) — 루나 normal / validation 거래 레일 분리 준비

핵심 구현:
- 기존 `ai.investment.crypto` launchd에 `INVESTMENT_TRADE_MODE=normal`을 명시해 정상거래 레일 역할을 고정
- 신규 `bots/investment/launchd/ai.investment.crypto.validation.plist` 추가
  - `INVESTMENT_TRADE_MODE=validation`
  - 별도 로그 `/tmp/investment-crypto-validation.log`, `/tmp/investment-crypto-validation.err.log`
  - 15분 주기 validation canary 레일로 정의
- `scripts/pre-reboot.sh`, `scripts/post-reboot.sh`가 validation 레일까지 인지하도록 보강
  - pre-reboot는 validation 서비스 정지 신호를 함께 처리
  - post-reboot는 validation 서비스를 선택적 서비스로 점검
- 운영 문서에 investment `normal / validation` 레일 개념을 반영
  - `OPERATIONS_RUNBOOK.md`
  - `team-features.md`
  - `SESSION_HANDOFF.md`

세션 맥락:
- 투자팀은 이미 코드 레이어에서 `investment.normal` / `investment.validation` guard scope와 `INVESTMENT_TRADE_MODE`를 지원하게 됐다.
- 다음 자연스러운 단계는 기존 launchd 구조를 깨지 않으면서 운영 레이어에서 분리하는 것이었다.

의사결정 이유:
- 기존 `ai.investment.crypto` 라벨은 덱스터/헬스/문서/운영 습관과 넓게 연결돼 있어, 전면 교체보다 호환 유지가 안정적이다.
- 따라서 `ai.investment.crypto`를 normal 레일로 유지하고 validation 레일만 별도 추가하는 방식이 내부 MVP 운영 안정성과 향후 SaaS용 mode/profile 확장성 사이 균형이 가장 좋다.

검증:
- `bash -n scripts/pre-reboot.sh`
- `bash -n scripts/post-reboot.sh`
- `plutil -lint bots/investment/launchd/ai.investment.crypto.plist`
- `plutil -lint bots/investment/launchd/ai.investment.crypto.validation.plist`

### 12주차 후속 (2026-03-19) — validation 전용 자금정책 / starter 승인 분리

핵심 구현:
- `capital-management.by_exchange.binance.trade_modes.validation` 추가
  - `reserve_ratio: 0.01`
  - `risk_per_trade: 0.01`
  - `max_position_pct: 0.08`
  - `max_concurrent_positions: 3`
  - `max_daily_trades: 8`
- `capital-manager.js`가 바이낸스에서 `INVESTMENT_TRADE_MODE`를 읽어 mode별 override를 자동 합성하도록 보강
- `nemesis.js`가 mode별 crypto risk threshold를 동적으로 읽도록 변경
  - validation 모드에서는 rejection 기준을 조금 완화
  - starter 승인 confidence/risk 범위를 넓히고 starter size를 더 작게 유지

세션 맥락:
- launchd 레일 분리만으로는 validation이 normal과 같은 행동을 해 운영 의미가 약했다.
- 그래서 validation은 “더 작은 금액으로 더 넓게 검증”한다는 운영 의도를 실제 자금정책과 리스크 승인에 반영할 필요가 있었다.

의사결정 이유:
- 내부 MVP 기준으로는 validation이 normal보다 더 공격적이기보다, 더 작은 손실 반경에서 더 많은 가설을 검증하는 쪽이 안정적이다.
- 향후 SaaS에서도 canary/validation 계층은 normal과 다른 risk profile을 쓰는 구조가 자연스럽다.

검증:
- `node --check bots/investment/shared/capital-manager.js`
- `node --check bots/investment/team/nemesis.js`
- `node --input-type=module -e "import { getCapitalConfig } from './bots/investment/shared/capital-manager.js'; console.log(JSON.stringify({ normal: getCapitalConfig('binance') }, null, 2));"`
- `INVESTMENT_TRADE_MODE=validation node --input-type=module -e "import { getCapitalConfig } from './bots/investment/shared/capital-manager.js'; console.log(JSON.stringify({ validation: getCapitalConfig('binance') }, null, 2));"`

### 12주차 후속 (2026-03-19) — 투자 `trade_mode` 영속화 + 일지/주간 리뷰 분리

핵심 구현:
- `signals`, `trades`, `trade_journal`에 `trade_mode` 컬럼을 저장하도록 확장
  - 기본값은 현재 실행 중인 `INVESTMENT_TRADE_MODE`
  - `normal` / `validation`이 DB 레코드 단위로 구분됨
- `pipeline_runs.meta`에 `investment_trade_mode`를 저장해 퍼널 메트릭도 운영모드별로 집계 가능하게 보강
- `trading-journal.js`
  - 거래 라인에 `[NORMAL]`, `[VALIDATION]` 태그 추가
  - 거래 리뷰 / decision 퍼널에 운영모드 요약 추가
- `weekly-trade-review.js`
  - 거래 요약 / 리뷰 섹션 / decision 퍼널에 운영모드 분리 집계 추가
- `trading-journal.js`는 실행 시작 시 `initJournalSchema()`를 명시적으로 호출하도록 보강
  - 기존 DB에서 `trade_journal.trade_mode` 컬럼이 아직 없을 때 일지가 `column j.trade_mode does not exist`로 실패하던 경로를 복구
- `crypto.js`는 `investment-state.json`을 `trade_mode`별 파일로 분리
  - `normal`과 `validation`이 같은 마지막 실행 시각/긴급트리거 상태를 공유하지 않도록 정리
  - validation canary가 normal 레일 쿨다운 때문에 스킵되는 운영 왜곡을 줄임

세션 맥락:
- launchd와 risk/capital 정책까지 분리된 뒤에도, 운영 데이터가 `normal`과 `validation`을 섞어 집계하면 검증레일의 의미가 약해진다.
- 따라서 이번 단계는 “운영모드 분리”를 코드 설정이 아니라 데이터 불변식으로 내리는 작업이었다.

의사결정 이유:
- 내부 MVP 기준으로도 validation은 canary 성격이므로 normal KPI와 섞이면 운영 판단이 왜곡된다.
- 향후 SaaS에서도 workspace / strategy profile / release rail을 분리 관측하려면 레코드 레벨 `trade_mode`는 필수 확장 포인트다.

검증:
- `node --check bots/investment/shared/db.js`
- `node --check bots/investment/shared/trade-journal-db.js`
- `node --check bots/investment/shared/pipeline-decision-runner.js`
- `node --check bots/investment/scripts/trading-journal.js`
- `node --check bots/investment/scripts/weekly-trade-review.js`
- `node bots/investment/scripts/trading-journal.js --days=1`
- `node bots/investment/scripts/weekly-trade-review.js --dry-run`
- `node --check bots/investment/markets/crypto.js`

### 12주차 후속 (2026-03-19) — 국내장/해외장 validation 레일 공용화

핵심 구현:
- `ai.investment.domestic.validation`, `ai.investment.overseas.validation` launchd 추가
  - `INVESTMENT_TRADE_MODE=validation`
  - 시장별 별도 validation 로그 경로 사용
- `scripts/pre-reboot.sh`, `scripts/post-reboot.sh`, `bots/claude/lib/checks/bots.js`가 세 시장 validation 레일을 선택적 서비스로 인지하도록 확장
- 운영 문서에 세 시장 공통 validation 활성화/비활성화 절차를 반영

세션 맥락:
- 국내장과 해외장은 장 시간이 제한적이지만 현재 모의투자 계좌 기준으로 검증 부담이 낮다.
- 따라서 crypto만이 아니라 세 시장 전체에서 validation 레일을 공용화하고, 세 시장의 시그널을 통합 피드백에 반영하는 방향이 더 맞는 전략으로 판단됐다.

의사결정 이유:
- 내부 MVP 관점에서는 세 시장 validation을 공용 구조로 먼저 깔아 두는 편이 빠르다.
- 이후 SaaS 확장 시에도 시장별 `normal / validation / canary` 레일을 공통 데이터 구조(`trade_mode`) 위에서 해석하는 쪽이 확장성이 좋다.

검증:
- `plutil -lint bots/investment/launchd/ai.investment.domestic.validation.plist`
- `plutil -lint bots/investment/launchd/ai.investment.overseas.validation.plist`
- `bash -n scripts/pre-reboot.sh`
- `bash -n scripts/post-reboot.sh`
- `node --check bots/claude/lib/checks/bots.js`

### 12주차 후속 (2026-03-19) — 재부팅 절차를 문서/세션 게이트로 재정리

핵심 구현:
- `scripts/pre-reboot.sh`를 `준비/대기`와 `--drain-now`로 분리
  - 기본 실행은 Git 상태 확인, `ai.*` launchd 스냅샷 저장, 문서 최신성 점검, 텔레그램 보고만 수행
  - `--drain-now`에서만 ai-agent-system 서비스 정지 신호를 보내고 사용자 최종 재시작을 기다리도록 정리
- 재부팅 전 필수 문서 게이트 추가
  - `SESSION_HANDOFF.md`
  - `WORK_HISTORY.md`
  - `CHANGELOG.md`
  - `TEST_RESULTS.md`
  - `PLATFORM_IMPLEMENTATION_TRACKER.md`
  - 위 문서가 최신 상태가 아니면 drain 단계가 중단되도록 보강
- `scripts/post-reboot.sh`를 현재 운영 구조 기준 전사 복구 점검형으로 확장
  - orchestrator / OpenClaw / n8n
  - worker web / nextjs / lead / task-runner
  - investment commander / markets / reporter / argos / alerts / prescreen
  - blog node-server / daily / health-check
  - claude commander / dexter / archer / health-dashboard
  - ska monitors
  까지 확인
- `/tmp/post-reboot-followup.txt`를 추가해 재부팅 후 상태 변화가 있으면 문서/핸드오프를 반드시 갱신하도록 체크리스트를 남김
- `docs/OPERATIONS_RUNBOOK.md`에 현재 운영 구조 기준 재부팅 표준 절차를 문서화

세션 맥락:
- 노트북에는 `ai-agent-system` 외 다른 시스템도 함께 돌아가므로, ai-agent-system 스크립트가 사용자 판단 없이 OS 종료를 실행하면 안 되는 상태였다.
- 기존 pre/post reboot 스크립트는 일부 팀 중심 절차라 현재 전사 운영 구조와 문서/핸드오프 요구사항을 모두 반영하지 못했다.

의사결정 이유:
- 내부 MVP 운영에서도 재부팅은 단순 시스템 이벤트가 아니라 운영 이벤트이므로, 서비스 정리보다 문서 업데이트와 세션 인수인계가 먼저 닫혀야 한다.
- 최종 재시작은 항상 사용자가 직접 실행하도록 남겨두는 편이 다른 로컬 시스템과의 충돌을 피하고 운영 안정성에 더 적합하다.

검증:
- `bash -n scripts/pre-reboot.sh`
- `bash -n scripts/post-reboot.sh`
- `bash scripts/post-reboot.sh --dry-run`

### 12주차 후속 (2026-03-18) — 워커 웹 `LLM API 현황` / `블로그 URL 입력` 운영 콘솔 정리

핵심 구현:
- 워커 웹 관리자 메뉴를 `마스터` 그룹으로 재정리하고 `LLM API 현황`, `블로그 URL 입력`을 마스터 전용 진입점으로 분리
- `/admin/monitoring/blog-links` 페이지를 추가해 최근 블로그 글 조회, 네이버 블로그 canonical URL 기록, 테스트 글 `34/36/38` 제외, `published + naver_url 없음`과 `ready + naver_url 없음` 상태 분리를 지원
- `/admin/monitoring`을 전사 `LLM API 현황` 콘솔로 재구성
  - `ai-agent-system 전체 에이전트 리스트`
  - 팀별 primary / fallback / 미적용 표시
  - selector별 `provider -> model` 2단계 편집
  - `primary / fallback` 역할 선택 후 현재 적용된 provider / model로 자동 동기화
  - `speed-test` 실행 버튼, 대상 목록, 최근 측정 결과, 최근 7일 review 요약 표시
- 전역 selector 현황은 외부 스크립트 실행 대신 워커 서버가 직접 `describeLLMSelector()`와 팀별 runtime override를 조합해 payload를 생성하도록 안정화

세션 맥락:
- 기존 워커 모니터링 화면은 전사 LLM 현황과 워커 전용 제어가 섞여 있어 운영 개념이 모호했다.
- 블로그 발행 URL 기록도 CLI로만 가능해 내부 링킹과 실제 발행 상태 관리가 운영 화면과 분리돼 있었다.

의사결정 이유:
- 내부 MVP 기준으로는 새 운영 센터를 따로 만들기보다, 기존 워커 웹을 마스터 운영 콘솔로 확장하는 편이 빠르고 안정적이다.
- selector, speed-test, 블로그 URL 기록을 한 화면/메뉴 체계 안에 모으는 것이 이후 SaaS 운영센터 UX로 확장하기 쉽다.

검증:
- `node --check bots/worker/web/server.js`
- `node --check bots/worker/web/app/admin/monitoring/page.js`
- `node --check bots/worker/web/app/admin/monitoring/blog-links/page.js`
- `npm --prefix bots/worker/web run build`
- `launchctl kickstart -k gui/$(id -u)/ai.worker.web`
- `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs`

### 12주차 후속 (2026-03-18) — 텔레그램 모바일 알림 UX 정리

핵심 구현:
- 공용 텔레그램 발송 직전 긴 구분선을 모두 `───────────────` 15자로 정규화
- `reporting-hub`의 모바일 축약 경로도 같은 15자 구분선을 사용하도록 맞춤
- 루나 direct report 상수도 같은 구분선 규칙으로 통일
- 제이 메인봇 queued notice 포맷에서 `headline`을 제목 우선값으로 사용하도록 바꿔 `ℹ️ 안내 / ℹ️ luna 알림 / 요약:` 중복을 축소
- 장전 스크리닝 완료 메시지는 심볼 최대 6개만 노출하고 초과분을 `외 N개`로 축약
- 장 마감 매매일지는 투자 성향/매매 내역/보유 포지션/신호 요약을 최대 개수 기준으로 축약

세션 맥락:
- 모바일 수신 화면에서 긴 구분선이 2줄로 꺾이고, 루나 큐 알림은 `안내`와 `bot 알림`이 동시에 보여 가독성이 떨어졌다.
- 장전/장마감 알림은 심볼과 상세 상태가 길게 이어져 핵심만 빠르게 보기 어려웠다.

의사결정 이유:
- 각 producer를 전면 수정하기보다 공용 `telegram-sender`와 `reporting-hub`에서 출력 규칙을 통일하는 것이 내부 MVP와 운영 안정성에 더 적합하다.
- 투자 알림은 상세판보다 모바일 요약판이 우선이므로, 핵심 정보만 남기고 `외 N개 / 외 N건`으로 축약하는 편이 실전 운영에 맞다.

실발송 검증:
- 개인 Telegram 채팅 직접 전송 `ok=true`
- 그룹 채팅 직접 전송 `ok=true`
- 루나 포럼 토픽 15 직접 전송 `ok=true`
- 실제 수신 화면에서 15자 구분선 1줄 유지와 테스트 메시지 헤더 중복 해소를 확인

검증:
- `node --check packages/core/lib/telegram-sender.js`
- `node --check packages/core/lib/reporting-hub.js`
- `node --check bots/investment/shared/report.js`
- `node --check bots/orchestrator/lib/batch-formatter.js`
- `node --check bots/investment/scripts/market-alert.js`
- `node --check bots/investment/scripts/pre-market-screen.js`
- `launchctl kickstart -k gui/$(id -u)/ai.orchestrator`
- `launchctl kickstart -k gui/$(id -u)/ai.investment.commander`
- `launchctl kickstart -k gui/$(id -u)/ai.investment.market-alert-domestic-open`
- `launchctl kickstart -k gui/$(id -u)/ai.investment.market-alert-domestic-close`
- `launchctl kickstart -k gui/$(id -u)/ai.investment.market-alert-overseas-open`
- `launchctl kickstart -k gui/$(id -u)/ai.investment.market-alert-overseas-close`
- `launchctl kickstart -k gui/$(id -u)/ai.investment.market-alert-crypto-daily`
- `launchctl kickstart -k gui/$(id -u)/ai.investment.prescreen-domestic`
- `launchctl kickstart -k gui/$(id -u)/ai.investment.prescreen-overseas`

### 12주차 후속 (2026-03-19) — 자동화 리포트 판단력 강화

핵심 구현:
- `jay-gateway-experiment-daily.js`가 스냅샷 저장 실패 시에도 기존 누적 스냅샷 기반 review를 계속 출력하고, `snapshotError / persisted` 상태를 명시하도록 보강
- `log-jay-gateway-experiment.js`와 `jay-gateway-experiment-daily.js`가 `~/.openclaw/workspace` 쓰기 실패 시 repo 내부 `tmp/jay-gateway-experiments.jsonl` fallback 저장을 사용하도록 보강
- `daily-ops-report.js`가 `process.execPath` 기준으로 health script를 실행하고, `health_report_failed_launchctl / health_report_failed_probe_unavailable` source와 `healthError`를 함께 노출하도록 정리
- `daily-ops-report.js`가 `현재 활성 이슈 / 누적 반복 이슈 / 입력 실패`를 분리해 시스템 문제와 입력 실패를 구분해서 읽도록 재구성
- `ska-sales-forecast-daily-review.js`에 `actionItems`를 추가해 `bias_tuning / weekday_tuning / manual_review / shadow_readiness`를 즉시 조치 항목으로 제공
- `ska-sales-forecast-weekly-review.js`에 `requestedDays / effectiveDays`와 `actionItems`를 추가해 일일/주간 운영 판단 포맷을 통일
- `trading-journal.js`에 `no-trade high-cost` 경고를 추가해 거래가 없는데 LLM 분석비용만 큰 날을 운영자가 바로 식별 가능하게 함
- `weekly-trade-review.js`가 종료 거래가 없어도 미결 포지션 / 주간 usage / 다음 조치를 포함한 운영 요약을 남기도록 보강
- `trading-journal.js`, `weekly-trade-review.js`의 `date_kst` 비교를 `::date` 기준으로 수정해 usage가 0으로 잘못 내려가던 불변식을 회복
- `jay-llm-daily-review.js`는 DB 접근 실패 시 `dbStatsStatus=partial`, `dbSourceErrors`, `session_usage_fallback` 기준 모델별 사용량을 함께 보여주도록 보강

세션 맥락:
- 오늘 점검한 자동화 리포트는 숫자 자체보다 “왜 hold인지”, “무엇을 바로 조치할지”가 약했다.
- 특히 제이 Gateway 자동화는 스냅샷 저장 실패 시 리포트 가치가 크게 떨어졌고, 일일 운영 분석은 health 입력 실패가 `hold` 뒤에 묻혀 있었다.

의사결정 이유:
- 내부 MVP 단계에서는 자동화를 늘리기보다, 기존 자동화가 실패해도 의미 있는 판단을 남기도록 만드는 편이 운영 안정성에 더 중요하다.
- 스카와 투자 리포트는 상세 수치보다 실행 가능한 액션 문구를 먼저 주는 편이 실무 운영 속도와 SaaS 확장성 모두에 유리하다.

검증:
- `node --check scripts/reviews/jay-gateway-experiment-daily.js`
- `node --check bots/orchestrator/scripts/log-jay-gateway-experiment.js`
- `node --check scripts/reviews/daily-ops-report.js`
- `node --check bots/investment/scripts/trading-journal.js`
- `node --check bots/investment/scripts/weekly-trade-review.js`
- `node --check scripts/reviews/jay-llm-daily-review.js`
- `node --check scripts/reviews/ska-sales-forecast-weekly-review.js`
- `node --check scripts/reviews/ska-sales-forecast-daily-review.js`
- `node scripts/reviews/jay-gateway-experiment-daily.js --json`
- `node -e "const {buildRun}=require('./scripts/reviews/jay-gateway-experiment-daily.js'); ..."`
- `node scripts/reviews/daily-ops-report.js --json`
- `node scripts/reviews/daily-ops-report.js`
- `node scripts/reviews/jay-llm-daily-review.js --json`
- `node scripts/reviews/jay-llm-daily-review.js`
- `node bots/investment/scripts/weekly-trade-review.js --dry-run`
- `node scripts/reviews/ska-sales-forecast-weekly-review.js --days=7 --json`
- `node scripts/reviews/ska-sales-forecast-daily-review.js --days=5 --json`

### 12주차 후속 (2026-03-18) — LLM selector 리포트에 speed-test 스냅샷 결합

핵심 구현:
- `scripts/speed-test.js`가 최신 측정 결과를 `~/.openclaw/workspace/llm-speed-test-latest.json`에 저장하도록 확장
- `scripts/llm-selector-report.js`가 selector의 `primary/fallback chain`과 최근 속도 스냅샷을 함께 출력하도록 확장
- 텍스트 출력에서는 각 체인 항목 옆에 `TTFT/총응답시간` 또는 실패 사유를 붙이고, JSON 출력에는 `speedTest` 스냅샷을 포함

세션 맥락:
- 공용 selector는 이미 주요 텍스트 LLM 경로를 중앙화했지만, 운영자가 실제 fallback 체인의 속도 근거까지 한 번에 보기는 어려웠다.
- 이번 단계에서 selector는 정책 레이어로 유지하고, speed-test는 관측 레이어로 분리한 채 최신 스냅샷만 느슨하게 연결했다.

의사결정 이유:
- selector와 speed-test를 완전히 한 코드로 섞지 않고, 최신 스냅샷 파일을 매개로 연결하는 것이 내부 MVP와 운영 안정성에 더 적합하다.
- 이 구조는 추후 SaaS에서도 tenant별 모델 체인 정책과 최근 성능 데이터를 함께 비교하는 기반으로 확장 가능하다.

검증:
- `node --check scripts/speed-test.js`
- `node --check scripts/llm-selector-report.js`
- `node scripts/llm-selector-report.js`

### 12주차 후속 (2026-03-18) — 제이 `/llm-selectors` 운영 조회 명령 추가

핵심 구현:
- 오케스트레이터에 `/llm-selectors` 슬래시 명령 추가
- 자연어 패턴 `LLM 체인 보여줘`, `현재 모델 폴백 체인 보여줘` 등을 `llm_selector_report` 인텐트로 연결
- 제이가 `scripts/llm-selector-report.js`를 직접 호출해 전 팀 selector / fallback / 최근 speed-test 스냅샷을 텔레그램에서 바로 보여주도록 정리

세션 맥락:
- 공용 selector 중앙화와 speed-test 스냅샷 결합은 끝났지만, 운영자가 이를 즉시 확인하는 명령 경로가 아직 없었다.
- 이번 단계에서 새 UI를 만들지 않고, 기존 제이 명령 체계 위에 얇게 붙여 운영 통제 가치를 바로 사용할 수 있게 했다.

의사결정 이유:
- 내부 MVP 기준으로는 새 화면보다 텔레그램/제이 명령이 더 빠르고 안전한 운영 진입점이다.
- 이 구조는 추후 운영 UI 조회나 SaaS 관리자 화면으로 확장하더라도 동일한 스크립트 출력을 재사용할 수 있다.

검증:
- `node --check bots/orchestrator/lib/intent-parser.js`
- `node --check bots/orchestrator/src/router.js`
- `/llm-selectors`, `LLM 체인 보여줘` 인텐트 매핑 확인

### 12주차 후속 (2026-03-18) — 워커 모니터링 UI에 selector 체인 카드 추가

핵심 구현:
- `/api/admin/monitoring/llm-api` payload에 `selector_summary` 추가
- 워커 모니터링 페이지에서
  - `worker.ai.fallback`
  - `worker.chat.task_intake`
  의 primary / fallback chain을 카드 형태로 노출
- DB 선호 provider와 runtime_config override가 실제로 어떤 체인으로 해석되는지 운영자가 화면에서 바로 확인 가능하게 정리

세션 맥락:
- 공용 selector 중앙화와 제이 명령 조회까지는 끝났지만, 워커 관리자 화면에서는 아직 실제 chain이 보이지 않았다.
- 이번 단계에서 기존 `/admin/monitoring`을 재사용해 운영자가 provider 선택과 실제 fallback 체인을 한 화면에서 같이 보게 만들었다.

의사결정 이유:
- 새 관리 화면을 만드는 것보다 기존 워커 모니터링 화면에 selector 상태를 붙이는 것이 내부 MVP와 운영 안정성에 더 적합하다.
- 이 패턴은 추후 블로그/클로드/제이 운영 UI로 확장할 때도 같은 payload 구조를 재사용할 수 있다.

검증:
- `node --check bots/worker/lib/llm-api-monitoring.js`
- `node --check bots/worker/web/server.js`
- `node --check bots/worker/web/app/admin/monitoring/page.js`
- `cd bots/worker/web && npm run build`

### 12주차 후속 (2026-03-18) — 워커 모니터링 UI에 전 팀 selector 개요 추가

핵심 구현:
- `/api/admin/monitoring/llm-api` payload에 `global_selector_summary` 추가
- 서버가 `scripts/llm-selector-report.js --json` 결과를 읽어 Jay / Worker / Claude / Blog / Investment chain을 그룹별로 요약
- 워커 `/admin/monitoring` 화면에서 전 팀 selector primary / fallback 체인을 한 번에 확인 가능하게 확장
- 최근 speed-test 스냅샷의 `capturedAt / current / recommended`도 화면 상단에 함께 노출

세션 맥락:
- 제이 명령과 워커 개별 selector 카드는 이미 있었지만, 운영자가 시스템 전체 LLM 체인을 한 번에 보는 화면은 아직 없었다.
- 이번 단계에서 기존 워커 모니터링 화면을 공용 운영 대시보드의 시작점으로 확장했다.

의사결정 이유:
- 새 운영 페이지를 추가하기보다 기존 `/admin/monitoring`에 전 팀 개요를 붙이는 것이 내부 MVP와 운영 안정성에 더 적합하다.
- 이 구조는 이후 SaaS 관리자 화면에서도 selector 상태 카드와 speed-test 요약을 같은 payload 형태로 재사용할 수 있다.

검증:
- `node --check bots/worker/web/server.js`
- `node --check bots/worker/web/app/admin/monitoring/page.js`
- `cd bots/worker/web && npm run build`

### 12주차 후속 (2026-03-18) — speed-test 기반 selector 추천 레이어 추가

핵심 구현:
- `packages/core/lib/llm-selector-advisor.js` 추가
- selector chain과 최근 speed-test 스냅샷을 비교해
  - `hold`
  - `compare`
  - `switch_candidate`
  - `observe`
  판단을 생성
- `scripts/llm-selector-report.js` 텍스트/JSON 출력에 `advice`를 포함

세션 맥락:
- 중앙 selector, fallback, speed-test 스냅샷, 운영 조회 경로까지는 이미 닫혔지만, “그래서 지금 무엇을 해야 하는가”를 자동으로 말해주는 판단 레이어는 없었다.
- 이번 단계에서 speed-test는 관측 레이어로 그대로 두고, selector 위에 얇은 advisor만 추가해 운영 해석성을 높였다.

의사결정 이유:
- selector가 speed 결과를 즉시 자동 반영하게 만들기보다, 먼저 `추천`만 제공하는 것이 내부 MVP와 운영 안정성에 더 적합하다.
- 이 구조는 나중에 runtime override 추천, 운영 승인 플로우, SaaS tenant별 정책 추천으로 자연스럽게 확장 가능하다.

검증:
- `node --check packages/core/lib/llm-selector-advisor.js`
- `node --check scripts/llm-selector-report.js`
- `node scripts/llm-selector-report.js --json`

### 12주차 후속 (2026-03-18) — 워커 모니터링 UI에 selector advisor 표시

핵심 구현:
- worker 개별 selector 카드에 `hold / compare / switch_candidate / observe` 배지와 근거 문구 추가
- 전 팀 selector 개요 카드에도 같은 advisor 판단과 candidate를 함께 노출
- 최근 speed-test 스냅샷이 없을 때는 대부분 `observe`로 표시되도록 운영 보수성을 유지

세션 맥락:
- selector advisor는 이미 계산되었지만, 운영자가 실제 화면에서 바로 읽을 수는 없었다.
- 이번 단계에서 워커 모니터링 화면이 “현재 chain 조회”를 넘어 “현재 추천 판단”까지 읽는 운영 대시보드 역할을 하게 됐다.

의사결정 이유:
- 새 판단 UI를 만들기보다 기존 워커 모니터링 화면에 추천 배지를 붙이는 것이 내부 MVP와 운영 안정성에 더 적합하다.
- 이 구조는 추후 제이/클로드/블로그 운영 화면에도 동일한 advice 패턴으로 확장하기 쉽다.

검증:
- `node --check bots/worker/lib/llm-api-monitoring.js`
- `node --check bots/worker/web/server.js`
- `node --check bots/worker/web/app/admin/monitoring/page.js`
- `cd bots/worker/web && npm run build`

### 12주차 후속 (2026-03-18) — selector advisor를 override 후보 추천으로 연결

핵심 구현:
- `scripts/llm-selector-override-suggestions.js` 추가
- `llm-selector-report --json`의 `advice`를 읽어 `compare / switch_candidate` 대상만 추려 override 후보로 변환
- 각 추천에 대해
  - selector key
  - current primary
  - candidate
  - config 파일
  - runtime_config 경로
  - suggested chain
  를 함께 출력

세션 맥락:
- selector advisor는 이미 계산되고 UI에도 노출되지만, 운영자가 실제 override를 어디에 반영해야 하는지는 직접 추론해야 했다.
- 이번 단계에서 자동 반영 없이도 “어느 config의 어느 path를 검토해야 하는가”를 바로 보여주는 추천 레이어를 추가했다.

의사결정 이유:
- 자산/운영과 연결된 모델 정책은 자동 변경보다 승인형 추천이 안전하다.
- 이 구조는 추후 `runtime_config` 승인 플로우, 변경 이력, SaaS tenant별 정책 추천으로 그대로 확장할 수 있다.

검증:
- `node --check scripts/llm-selector-override-suggestions.js`
- `node scripts/llm-selector-override-suggestions.js`
- `node scripts/llm-selector-override-suggestions.js --json`

### 12주차 후속 (2026-03-18) — override 추천을 제이 명령과 워커 화면에 노출

핵심 구현:
- 제이 `/llm-selectors` 응답에 `llm-selector-override-suggestions.js` 결과를 함께 붙여 출력
- 워커 `/admin/monitoring`의 전 팀 selector 개요에 `override 추천 후보` 카드 추가
- 추천 후보별로
  - decision
  - current primary
  - candidate
  - config 파일
  - runtime_config path
  - reason
  을 운영자가 바로 읽을 수 있게 정리

세션 맥락:
- override 추천 스크립트는 이미 있었지만, 운영자가 별도 스크립트를 직접 실행해야만 볼 수 있었다.
- 이번 단계에서 제이 명령과 워커 운영 화면이 추천까지 함께 보여주는 실전 운영 진입점이 되었다.

의사결정 이유:
- 내부 MVP 기준으로는 별도 새 화면보다 기존 운영 경로에 추천을 얹는 것이 더 빠르고 안정적이다.
- 이 구조는 추후 승인/보류 이력, override 적용 워크플로, SaaS 관리자 정책 검토 UI로 그대로 확장하기 좋다.

검증:
- `node --check bots/orchestrator/src/router.js`
- `node --check bots/worker/web/server.js`
- `node --check bots/worker/web/app/admin/monitoring/page.js`
- `cd bots/worker/web && npm run build`

### 12주차 후속 (2026-03-18) — 워커 문서 재사용 품질 신호 추가

핵심 구현:
- `/documents` 목록에 문서별 `재사용 양호 / 재사용 주의 / 검토 필요` 품질 배지 추가
- `/documents` 목록에 `전체 품질 / 최신순 / 품질 검토 우선 / 전환율 높은 순 / 재사용 많은 순 / 연결 많은 순` 필터/정렬 추가
- `/documents/[id]` 상세에 `문서 품질 신호` 카드 추가
- `/documents/[id]` 상세에 `AI 확인 세션 / 무수정 확정률 / 평균 수정 필드 수` 효율 카드 추가
- 서버가 `extraction_metadata`를 바탕으로 품질 상태와 사유를 공통 계산하도록 정리
- `document_reuse_events`와 `ai_feedback_sessions/events`를 조합해 새 저장소 없이 효율 지표 계산
- 저품질 이미지 OCR, 추출 실패, 짧은 텍스트 문서를 재사용 전 빠르게 구분 가능하게 확장

세션 맥락:
- 워커 문서 흐름은 이미 업로드, 재사용 이력, 연결 결과, 전환율까지 올라와 있었다.
- 이번 단계에서는 “왜 어떤 문서가 실제 업무 재사용에서 약한지”를 운영자가 바로 읽을 수 있도록, 품질 신호를 목록과 상세에 붙였다.

의사결정 이유:
- 새 평가 테이블을 만들기보다 기존 `extraction_metadata`와 `document_reuse_events`를 조합하는 것이 내부 MVP와 운영 안정성에 더 유리하다.
- 품질 신호는 추후 SaaS 확장 시 문서 품질 분석, OCR 정책 튜닝, 재사용 효율 비교의 기반 데이터로 재사용할 수 있다.

검증:
- `node --check bots/worker/web/server.js`
- `node --check bots/worker/web/app/documents/page.js`
- `node --check 'bots/worker/web/app/documents/[id]/page.js'`
- `cd bots/worker/web && npm run build`

### 12주차 후속 (2026-03-18) — 워커 문서 개선 대상 리뷰 추가

핵심 구현:
- `bots/worker/scripts/document-efficiency-review.js` 추가
- 종합 효율 점수를 바탕으로
  - 개선 우선 문서
  - 좋은 템플릿 후보
  - OCR 재검토 우선 문서
  를 자동으로 요약
- 새 저장소 없이 기존 문서/재사용/피드백/OCR 메타데이터 집계를 재사용

세션 맥락:
- 워커 문서 흐름은 품질, 전환율, 수정량, 효율 점수까지 올라왔지만, 운영자가 “무엇부터 개선할지”를 한 번에 읽는 리포트는 아직 없었다.
- 이번 단계에서 점수와 품질 신호를 실제 운영 우선순위 리뷰로 연결했다.

의사결정 이유:
- UI를 더 늘리기보다 먼저 스크립트형 리뷰로 개선 우선순위를 확인하는 것이 내부 MVP에 더 적합하다.
- 이 구조는 추후 주간 운영 리포트, 문서 개선 백로그, SaaS 문서 자산 개선 리포트로 그대로 확장할 수 있다.

검증:
- `node --check bots/worker/scripts/document-efficiency-review.js`
- `node bots/worker/scripts/document-efficiency-review.js --company-id=1 --limit=5 --json`

### 12주차 후속 (2026-03-18) — 워커 문서 종합 효율 점수 추가

핵심 구현:
- `buildDocumentEfficiencySummary()` 추가
- 문서 품질 상태, 전환율, 무수정 확정률, 평균 수정 필드 수, 재사용 표본 수를 묶어 `효율 점수` 계산
- `/documents` 목록에 `효율 높은 순` 정렬과 효율 배지 추가
- `/documents/[id]` 상세에 종합 효율 점수와 근거 배지 추가

세션 맥락:
- 워커 문서 흐름은 품질/재사용/수정량 지표까지는 이미 올라와 있었지만, 운영자가 “좋은 문서 자산”을 한 번에 판별하긴 어려웠다.
- 이번 단계에서 흩어진 지표를 하나의 운영 점수로 묶어 우선순위가 더 선명하게 보이도록 정리했다.

의사결정 이유:
- 새 평가 테이블 없이 기존 `documents`, `document_reuse_events`, `ai_feedback_sessions/events`, `extraction_metadata`를 재사용하는 것이 내부 MVP와 운영 안정성에 더 적합하다.
- 이 점수는 추후 SaaS 문서 자산 등급, 템플릿 우선순위, OCR 정책 개선 대상 선정으로 자연스럽게 확장 가능하다.

검증:
- `node --check bots/worker/web/server.js`
- `node --check bots/worker/web/app/documents/page.js`
- `node --check 'bots/worker/web/app/documents/[id]/page.js'`
- `cd bots/worker/web && npm run build`

### 12주차 후속 (2026-03-18) — 스카 shadow 판단 레이어 명시화

핵심 구현:
- 스카 일일/주간 예측 리뷰에 `shadowDecision` 추가
- 단계:
  - `데이터 수집 단계`
  - `비교 관찰 단계`
  - `앙상블 편입 후보/실험 후보`
  - `기존 엔진 유지`
- `availableDays`, `requiredDays`, `gapThreshold`, `recommendation`, `reason`를 JSON과 텍스트 출력에 함께 반영

세션 맥락:
- shadow 비교 저장과 리뷰 연결은 이미 되어 있었지만, `availableDays = 0`일 때 운영자가 “지금 무엇을 기다리는지”를 바로 읽기 어려웠다.
- 이번 단계에서 리포트가 스스로 현재 shadow 관찰 단계를 설명하게 만들어, 스카 운영 판단을 더 명확히 했다.

의사결정 이유:
- 새 자동화 레이어를 만들기보다 기존 일일/주간 리뷰 출력에 판단 객체를 추가하는 것이 내부 MVP와 운영 해석성에 더 유리하다.
- 이 판단 객체는 추후 shadow 승격 자동화, 앙상블 실험 승인, SaaS tenant별 예측 엔진 비교에도 그대로 재사용할 수 있다.

검증:
- `node --check scripts/reviews/ska-sales-forecast-daily-review.js`
- `node --check scripts/reviews/ska-sales-forecast-weekly-review.js`
- `node scripts/reviews/ska-sales-forecast-daily-review.js --days=14 --json`
- `node scripts/reviews/ska-sales-forecast-weekly-review.js --days=42 --json`

### 12주차 후속 (2026-03-18) — 투자 runtime_config 제안 리포트 추가

핵심 구현:
- `bots/investment/scripts/runtime-config-suggestions.js` 추가
- 최근 14일 신호/실행/실패 코드/분석가 HOLD 편향을 읽어 `current -> suggested` 형식의 설정 후보 출력
- `adjust / hold / confidence / reason`를 함께 출력해 자동 변경이 아닌 운영 검토용 제안 리포트로 정리
- `package.json`에 `runtime-suggest` 실행 진입점 추가

세션 맥락:
- 투자팀은 `runtime_config` 외부화와 시장별 리뷰는 이미 올라와 있었지만, 실제 운영 데이터에서 “어떤 키를 왜 바꿔야 하는지”를 한 번에 보여주는 레이어가 없었다.
- 이번 단계에서 암호화폐/국내장/해외장의 최근 실행률과 실패 코드를 바로 설정 제안으로 연결했다.

의사결정 이유:
- 설정을 자동 변경하기보다 `current -> suggested` 리포트만 먼저 만드는 것이 내부 MVP와 운영 안정성에 더 유리하다.
- 이 구조는 추후 일일/주간 자동화, 마스터 승인 후 반영, SaaS tenant별 튜닝 제안으로 확장하기 쉽다.

검증:
- `node --check bots/investment/scripts/runtime-config-suggestions.js`
- `node bots/investment/scripts/runtime-config-suggestions.js --days=14 --json`
- `node bots/investment/scripts/runtime-config-suggestions.js --days=14`

### 12주차 후속 (2026-03-18) — 투자 runtime_config 제안 이력 저장

핵심 구현:
- `investment.runtime_config_suggestion_log` 테이블 추가
- `bots/investment/shared/db.js`에 제안 스냅샷 저장/조회 헬퍼 추가
- `runtime-config-suggestions.js`에 `--write` 옵션 추가
- 제안 리포트를 화면 출력과 동시에 운영 이력으로 남길 수 있게 정리

세션 맥락:
- 투자팀은 최근 운영 데이터 기반 `current -> suggested` 제안까지는 가능했지만, 어떤 제안이 언제 나왔는지 누적 이력이 없었다.
- 이번 단계에서 자동 적용 없이도 제안 스냅샷을 저장해 승인/보류/반려 흐름의 기반을 먼저 만들었다.

의사결정 이유:
- 자산 연결 값은 자동 변경보다 운영 검토와 이력 보존이 더 중요하다.
- 새 리뷰 엔진을 만들기보다 기존 제안 스크립트에 `--write`를 붙이고 DB 로그 테이블을 얇게 추가하는 것이 내부 MVP와 운영 안정성에 더 적합하다.
- 이 구조는 추후 `review_status`, `review_note`, `applied_at` 같은 승인 이력과 SaaS tenant별 설정 감사 추적으로 자연스럽게 확장 가능하다.

검증:
- `node --check bots/investment/shared/db.js`
- `node --check bots/investment/scripts/runtime-config-suggestions.js`
- `node bots/investment/scripts/runtime-config-suggestions.js --days=14 --json`
- `node bots/investment/scripts/runtime-config-suggestions.js --days=14 --write`

### 12주차 후속 (2026-03-18) — 투자 runtime_config 제안 검토 상태 저장

핵심 구현:
- `review-runtime-config-suggestion.js` 추가
- 저장된 제안 로그를 `pending / hold / approved / rejected / applied` 상태로 갱신 가능하게 정리
- `runtime_config_suggestion_log`에 `reviewed_at`, `applied_at` 추적 컬럼 추가
- 최근 제안 목록 조회와 단건 상태 변경을 같은 스크립트로 처리

세션 맥락:
- 제안 이력 저장까진 닫혔지만, 실제 운영에서는 어떤 제안을 승인했는지, 보류했는지, 적용했는지를 남길 경로가 추가로 필요했다.
- 이번 단계에서 자산 연결 설정의 감사 흐름을 위해 최소한의 검토 이력 레이어를 붙였다.

의사결정 이유:
- 별도 승인 서비스나 UI를 먼저 만들기보다, 기존 로그 테이블과 CLI 검토 스크립트를 재사용하는 것이 내부 MVP와 운영 안정성에 더 적합하다.
- `reviewed_at`, `applied_at`만 추가해도 추후 자동화, 세션 리뷰, SaaS 관리자 감사 추적까지 충분히 확장 가능하다.

검증:
- `node --check bots/investment/shared/db.js`
- `node --check bots/investment/scripts/review-runtime-config-suggestion.js`
- `node bots/investment/scripts/review-runtime-config-suggestion.js --list --json`
- `node bots/investment/scripts/review-runtime-config-suggestion.js --id=<suggestion_log_id> --status=hold --note='운영 검토 유지' --json`

### 12주차 후속 (2026-03-18) — 투자 runtime_config 승인안 적용 경로 추가

핵심 구현:
- `apply-runtime-config-suggestion.js` 추가
- 승인된 제안 스냅샷을 `config.yaml > runtime_config`에 반영하는 미리보기/실반영 경로 추가
- 반영 성공 시 suggestion log를 `applied`로 올리고 `applied_at` 자동 기록
- 부분 반영을 위한 `--keys` 선택과 안전한 기본값(`미리보기`) 유지
- 임시 `--config=/tmp/...` 테스트는 실제 운영 반영으로 보지 않고 DB 상태를 올리지 않도록 경계 고정

세션 맥락:
- 제안 생성, 저장, 검토 상태 갱신까지는 닫혔지만 실제 운영에서는 승인된 제안을 설정 파일에 반영하고 이력을 `applied`로 연결하는 마지막 고리가 필요했다.
- 이번 단계에서 자동 적용을 남발하지 않고, 승인 상태와 `--write`가 함께 있을 때만 반영되는 안전 경로를 붙였다.

의사결정 이유:
- 자산 연결 설정은 UI보다 스크립트 경로가 먼저 안전하고, 기본 동작을 미리보기로 두는 것이 운영 안정성에 더 적합하다.
- 기존 suggestion log와 `config.yaml` 구조를 재사용해 “승인 → 적용 → applied_at 기록”만 추가하는 것이 내부 MVP와 추후 SaaS 감사 추적 모두에 유리하다.

검증:
- `node --check bots/investment/scripts/apply-runtime-config-suggestion.js`
- `node bots/investment/scripts/apply-runtime-config-suggestion.js --id=<suggestion_log_id> --config=/tmp/investment-config-test.yaml --json`
- `node bots/investment/scripts/apply-runtime-config-suggestion.js --id=<suggestion_log_id> --config=/tmp/investment-config-test.yaml --write --json`

### 12주차 후속 (2026-03-18) — 투자 runtime_config 적용 후 검증 리포트 추가

핵심 구현:
- `validate-runtime-config-apply.js` 추가
- suggestion log 상태, 최근 N일 시장별 실행 요약, 투자팀 health-report를 한 번에 묶는 검증 리포트 경로 추가
- 적용 직후 “상태는 applied인데 health 경고가 있는지”, “최근 BUY 대비 실행이 여전히 0건인지”를 바로 읽을 수 있게 정리

세션 맥락:
- 제안 생성/저장/검토/적용까지는 닫혔지만, 실제 운영에서는 적용 직후에 설정 효과를 확인하는 마지막 점검이 필요했다.
- 이번 단계에서 새 평가 엔진을 만들지 않고 기존 health-report와 signals 집계를 재사용해 얇은 검증 레이어를 붙였다.

의사결정 이유:
- 내부 MVP에서는 적용 직후 빠르게 읽을 수 있는 검증 보고가 중요하고, 추후 SaaS에서도 tenant별 설정 변경 효과 검증에 그대로 재사용 가능하다.
- 기본 health와 최근 실행률을 먼저 묶어보는 것이 가장 안전하고, 이후에만 더 정교한 PnL/체결 분석으로 확장하는 것이 맞다.

검증:
- `node --check bots/investment/scripts/validate-runtime-config-apply.js`
- `node bots/investment/scripts/validate-runtime-config-apply.js --id=<suggestion_log_id> --days=7 --json`

### 12주차 후속 (2026-03-18) — 워커 모니터링 운영 지표 고도화

핵심 구현:
- `/admin/monitoring` 페이지에 최근 24시간 LLM 호출 통계 카드 추가
- API별 사용량, 경로별 사용량, 마지막 호출 시각을 한 화면에서 확인 가능하게 정리
- 기본 API 변경 이력을 `worker.system_preference_events`에 저장하도록 확장
- 누가 언제 `Groq/Anthropic/OpenAI/Gemini`로 바꿨는지 최근 이력을 관리자 화면에 노출
- `018-monitoring-history` 마이그레이션 추가 및 실제 DB 반영

세션 맥락:
- 워커 모니터링은 기존에 “무슨 API를 쓸지”만 바꾸는 관리 화면이었다.
- 운영자 관점에서는 변경 이력과 실제 호출량이 함께 있어야 설정 변경의 효과를 판단할 수 있어서, 이번 단계에서 운영 지표를 닫았다.

의사결정 이유:
- 새로운 로그 저장소를 만들기보다 기존 `reservation.llm_usage_log`와 워커 전용 설정 테이블을 재사용하는 것이 내부 MVP와 운영 안정성에 더 유리하다.
- provider 변경 이력은 단순 현재값보다 훨씬 중요한 운영 데이터라 별도 이벤트 테이블로 남기는 것이 추후 SaaS 감사 추적에도 맞다.

검증:
- `node --check bots/worker/lib/llm-api-monitoring.js`
- `node --check bots/worker/web/server.js`
- `node --check bots/worker/scripts/setup-worker.js`
- `cd bots/worker/web && npm run build`
- `node bots/worker/migrations/018-monitoring-history.js`
- `node bots/worker/scripts/health-report.js --json`

### 12주차 후속 (2026-03-18) — 워커 모니터링 품질 지표 추가

핵심 구현:
- `/admin/monitoring`의 최근 24시간 통계에 `성공률`과 `평균 응답시간` 추가
- API별 사용량 카드에 provider별 `성공률 / 평균 응답시간` 추가
- 경로별 사용량 카드에 route별 `성공률 / 평균 응답시간` 추가
- 기존 `reservation.llm_usage_log`의 `success`, `latency_ms`를 재사용해 새 저장소 없이 품질 지표를 계산

세션 맥락:
- 워커 모니터링은 이미 “무슨 API를 쓸지”와 “누가 바꿨는지”를 볼 수 있게 됐다.
- 이번 단계에서는 운영자가 설정 변경의 실제 품질까지 같은 화면에서 판단할 수 있도록, 호출량 중심 화면을 품질 지표 중심까지 확장했다.

의사결정 이유:
- 내부 MVP 단계에서는 새 이벤트 저장 구조를 늘리기보다 기존 `llm_usage_log`를 재사용하는 것이 가장 빠르고 안전하다.
- 단순 호출 수보다 `성공률`과 `응답시간`이 있어야 provider 전환 판단이 가능하고, 이는 추후 SaaS 운영 대시보드에서도 바로 재사용 가능한 축이다.

검증:
- `node --check bots/worker/lib/llm-api-monitoring.js`
- `node --check bots/worker/web/server.js`
- `node --check bots/worker/web/app/admin/monitoring/page.js`
- `cd bots/worker/web && npm run build`

### 12주차 후속 (2026-03-18) — 워커 모니터링 변경 사유(note) 추가

핵심 구현:
- 워커 기본 LLM API 저장 시 변경 사유(note)를 함께 입력하도록 `/admin/monitoring` 화면 확장
- `worker.system_preference_events.change_note` 컬럼 추가
- 변경 이력 카드에서 `이전 API → 다음 API`와 함께 변경 사유까지 조회 가능하게 정리
- `019-monitoring-change-notes` 마이그레이션 추가 및 실제 DB 반영

세션 맥락:
- 워커 모니터링은 이미 호출량, 성공률, 응답시간까지 읽을 수 있게 됐다.
- 이번 단계에서는 “왜 바꿨는지”를 남겨, 설정 변경과 운영 결과를 사람도 AI도 같이 해석할 수 있는 감사 추적 흐름을 완성했다.

의사결정 이유:
- 새로운 운영 노트 테이블을 만들기보다 기존 `worker.system_preference_events`를 확장하는 것이 내부 MVP와 데이터 일관성에 더 유리하다.
- 변경 사유 메모는 추후 SaaS 환경에서 관리자 감사 추적과 설정 변경 분석의 기본 데이터가 된다.

검증:
- `node --check bots/worker/lib/llm-api-monitoring.js`
- `node --check bots/worker/web/server.js`
- `node --check bots/worker/web/app/admin/monitoring/page.js`
- `node --check bots/worker/scripts/setup-worker.js`
- `cd bots/worker/web && npm run build`
- `node bots/worker/migrations/019-monitoring-change-notes.js`

### 12주차 후속 (2026-03-18) — 워커 모니터링 전후 품질 비교 추가

핵심 구현:
- 최근 기본 API 변경 3건에 대해 전후 12시간 품질 비교 카드 추가
- 변경 전/후 각각 호출 수, 성공률, 평균 응답시간을 같은 화면에서 비교 가능하게 정리
- 성공률 변화(%p)와 응답시간 변화(ms)를 delta로 계산
- 별도 저장소 없이 기존 변경 이력과 `reservation.llm_usage_log`를 조합해 계산

세션 맥락:
- 워커 모니터링은 이제 현재값, 변경 사유, 호출 품질을 모두 볼 수 있게 됐다.
- 이번 단계에서는 “바꾼 뒤 실제로 나아졌는가”를 바로 판단할 수 있도록, 최근 변경의 전후 효과를 같은 관리자 화면에 붙였다.

의사결정 이유:
- 내부 MVP 단계에서는 추세 분석 전용 테이블을 새로 두기보다, 기존 이벤트와 호출 로그를 조합하는 것이 가장 빠르고 안전하다.
- 전후 비교는 provider 전환 실험의 근거가 되며, 추후 SaaS 운영 대시보드에서도 그대로 재사용 가능한 판단 축이다.

검증:
- `node --check bots/worker/lib/llm-api-monitoring.js`
- `node --check bots/worker/web/server.js`
- `node --check bots/worker/web/app/admin/monitoring/page.js`
- `cd bots/worker/web && npm run build`

### 12주차 후속 (2026-03-18) — 투자 실패 이력 구조화 백필

핵심 구현:
- `backfill-signal-block-reasons.js`가 빈 `block_reason`뿐 아니라 `block_code`, `block_meta`가 비어 있는 `legacy_*` 실패 이력까지 구조화 대상으로 확장
- 과거 국내/해외/암호화폐 실패 14건에 `block_code`, `block_meta` 실제 반영
- 자동매매 일지에서 실패 사유 옆에 `[min_order_notional]`, `[legacy_order_rejected]` 같은 구조화 코드가 함께 보이도록 확장
- 자동매매 일지에 시장별 `실패 코드 요약` 섹션 추가

세션 맥락:
- 신규 실패는 이미 구조화 저장이 되지만, 과거 데이터는 `legacy_*` 문자열만 남아 있어 운영 튜닝 근거로 쓰기 어려웠다.
- 이번 단계에서 과거 이력까지 최소한 코드형 분류와 실행 맥락을 채워, 일지와 후속 자동화가 같은 기준으로 읽을 수 있게 만들었다.

의사결정 이유:
- 새로운 분석 레이어를 만들기보다 기존 `signals` 테이블의 `block_code`, `block_meta`를 백필하는 것이 내부 MVP와 데이터 일관성에 더 유리하다.
- 상세 원인 복원이 불가능한 건 `legacy_*` 코드로 남기되, 적어도 시장/심볼/행동/금액 맥락은 구조화해 두는 것이 추후 SaaS 리포트에도 도움이 된다.

검증:
- `node --check bots/investment/scripts/backfill-signal-block-reasons.js`
- `node --check bots/investment/scripts/trading-journal.js`
- `node bots/investment/scripts/backfill-signal-block-reasons.js --days=30`
- `node bots/investment/scripts/trading-journal.js --days=7`

### 12주차 후속 (2026-03-18) — 제이 모델 정책 운영 설정 연결

핵심 구현:
- `orchestrator/config.json`에 `runtime_config.jayModels` 추가
- `jay-model-policy.js`가 하드코딩 상수 대신 runtime config를 읽도록 확장
- `intent-parser.js`가 `buildIntentParsePolicy()`를 사용하도록 정리
- `/jay-models`, "제이 지금 무슨 모델 써?" 질의로 현재 gateway / intent / chat fallback 정책을 조회 가능하게 추가
- 런북과 세션 인덱스에 “제이 모델은 어디서 읽는가” 경로를 명시

세션 맥락:
- 제이 모델 정책은 이미 코드상 분리돼 있었지만, 운영자가 설정 파일과 문서에서 바로 찾을 수 있는 상태는 아니었다.
- 이번 단계에서 OpenClaw 기본 모델과 제이 앱 커스텀 모델을 구분한 채, 운영 오버라이드 값을 한 곳에서 보이게 만들었다.

의사결정 이유:
- gateway primary를 즉시 바꾸기보다, 먼저 운영 설정과 문서에서 같은 언어로 읽히게 만드는 것이 내부 MVP와 운영 안정성에 더 유리하다.
- 추후 SaaS 확장 시 tenant/workspace별 모델 정책을 올릴 수 있는 최소 기반으로 `runtime_config` 연결이 더 적합하다.

검증:
- `node --check bots/orchestrator/lib/runtime-config.js`
- `node --check bots/orchestrator/lib/jay-model-policy.js`
- `node --check bots/orchestrator/lib/intent-parser.js`

### 12주차 후속 (2026-03-18) — 제이 gateway primary 정합성 점검 레이어 추가

핵심 구현:
- `openclaw.json` 실제 gateway primary를 읽는 [openclaw-config.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/openclaw-config.js) 추가
- `runtime_config.jayModels.gatewayPrimary`와 `~/.openclaw/openclaw.json`의 실제 primary를 비교하는 [check-jay-gateway-primary.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/check-jay-gateway-primary.js) 추가
- `/jay-models` 응답에 `runtime_config 기준 / openclaw.json 실제값 / 정합성`을 함께 표시하도록 보강
- 필요 시 `--apply`로 OpenClaw primary를 runtime_config 기준으로 동기화할 수 있는 운영 준비 경로 추가

세션 맥락:
- 제이 모델 정책은 이미 코드와 runtime_config에서 분리돼 있었지만, 외부 OpenClaw 설정의 실제값까지 한 번에 읽는 운영 도구는 없었다.
- 이번 단계에서 “무엇을 기준값으로 보고, 실제값은 무엇이며, 둘이 맞는가”를 먼저 확인하는 절차를 고정했다.

의사결정 이유:
- 외부 OpenClaw 설정을 바로 바꾸기보다 정합성 점검 레이어를 먼저 두는 것이 내부 MVP와 운영 안정성에 더 유리하다.
- 이 방식은 추후 SaaS에서 앱 정책과 플랫폼 기본 정책을 분리 관리할 때도 그대로 확장 가능하다.

검증:
- `node --check bots/orchestrator/lib/openclaw-config.js`
- `node --check bots/orchestrator/scripts/check-jay-gateway-primary.js`
- `node --check bots/orchestrator/src/router.js`
- `node bots/orchestrator/scripts/check-jay-gateway-primary.js --json`

### 12주차 후속 (2026-03-18) — 제이 gateway primary 후보/권장 판단 추가

핵심 구현:
- `check-jay-gateway-primary.js`가 단순 정합성 체크를 넘어서 후보 프로필과 권장 판단까지 출력하도록 확장
- 후보 프로필을 `Gemini Flash 유지 / Groq GPT-OSS / Anthropic Haiku` 3종으로 정리
- 현재 상태가 정합성 일치 + 헬스 안정이면 `hold`를 기본 권장으로 보여주도록 보강
- `/jay-models` 응답에도 “지금은 유지가 기본 권장”이라는 운영 해석 문구 추가

세션 맥락:
- gateway primary를 바꿀 수 있는 도구는 이미 준비됐지만, 내부 MVP 단계에서는 바꾸는 것보다 언제 바꾸지 말아야 하는지를 명확히 하는 것이 더 중요했다.
- 이번 단계에서 운영자가 모델 변경을 감으로 하지 않도록, 후보와 권장 판단을 같은 점검 레이어에 넣었다.

의사결정 이유:
- 현재는 runtime_config와 openclaw.json이 일치하고 오케스트레이터 헬스도 안정 구간이라, 즉시 전환보다 유지가 더 합리적이다.
- 후보 프로필을 미리 정리해 두면 추후 SaaS 확장 시 workspace별 모델 정책도 같은 구조로 비교 가능하다.

검증:
- `node --check bots/orchestrator/lib/openclaw-config.js`
- `node --check bots/orchestrator/scripts/check-jay-gateway-primary.js`
- `node --check bots/orchestrator/src/router.js`
- `node bots/orchestrator/scripts/check-jay-gateway-primary.js`

### 12주차 후속 (2026-03-18) — 제이 gateway primary 전환 실험 기준표 정리

핵심 구현:
- `check-jay-gateway-primary.js`에 전환 후보별 장단점과 현재 권장 판단을 구조화해 출력
- 현재 기준에서 `hold`가 왜 맞는지 스크립트와 문서 모두에서 같은 언어로 설명하도록 정리
- 전환 후보를 `Gemini Flash 유지 / Groq GPT-OSS 전환 / Anthropic Haiku 전환` 3개로 고정
- 전환 단계를 `hold / compare / switch` 3단계로 고정해, 운영자가 언제 유지하고 언제 비교하며 언제 실제 전환할지 같은 판단 틀로 읽게 정리
- `log-jay-gateway-experiment.js`를 추가해 gateway 로그, 제이 usage, health-report, primary 정합성을 한 번에 스냅샷으로 남길 수 있게 정리
- 실험 로그는 기본적으로 `~/.openclaw/workspace/jay-gateway-experiments.jsonl`에 append되어, 이후 전환 전후 비교 근거로 재사용 가능
- `jay-gateway-experiment-review.js`를 추가해 누적 스냅샷을 `hold / compare / sync_first` 권장 판단으로 읽을 수 있게 정리
- `jay-gateway-experiment-daily.js`를 추가해 기록과 리뷰를 한 번에 실행하는 일일 운영 진입점을 고정
- `jay-gateway-change-compare.js`를 추가해 실제 전환 시점을 기준으로 전/후 24시간 개선 여부를 `improved / neutral / regressed`로 판정할 수 있게 정리
- `prepare-jay-gateway-switch.js`를 추가해 후보 모델별 사전 점검, 실행 절차, 롤백 기준을 계획 형태로 바로 출력할 수 있게 정리

세션 맥락:
- 이전 단계까지는 “현재 기준값과 실제값이 맞는지”를 확인하는 레이어를 만들었다.
- 이번 단계에서는 “그렇다면 지금 바꾸는 게 맞는가”에 답하기 위한 운영 판단 기준표를 붙였다.

의사결정 이유:
- 내부 MVP 단계에서는 무작정 전환보다 유지 판단의 근거를 먼저 명확히 해야 한다.
- 비교 기준이 있어야 이후 SaaS 확장 시에도 workspace별 모델 정책 전환을 일관되게 판단할 수 있다.

검증:
- `node --check bots/orchestrator/lib/openclaw-config.js`
- `node --check bots/orchestrator/scripts/check-jay-gateway-primary.js`
- `node --check bots/orchestrator/src/router.js`
- `node bots/orchestrator/scripts/check-jay-gateway-primary.js`

### 12주차 후속 (2026-03-18) — 제이 모델 정책 분리 + 오류 리뷰 최근성 보정

핵심 구현:
- `bots/orchestrator/lib/jay-model-policy.js` 신규 추가
- 제이 모델 체계를 `OpenClaw gateway 기본 primary`와 `제이 앱 커스텀 정책`으로 분리
- `intent-parser.js`의 `gpt-5-mini -> gemini-2.5-flash` 명령 해석 정책을 집약 파일로 이동
- `router.js`의 자유대화 fallback 체인을 집약 파일로 이동
- `error-log-daily-review.js`에 `최근 3시간 활성 오류`와 `하루 누적 오류`를 분리
- 종료된 `OpenClaw gateway rate limit`이 현재 장애처럼 과장되지 않도록 보정
- `onchain-data.js`에서 `nextFundingTime` 비정상 값 방어 추가

세션 맥락:
- 제이는 실제로 하나의 모델을 쓰는 구조가 아니라, OpenClaw 기본 모델과 제이 앱 레벨 모델 정책이 섞여 있었다.
- 운영자 입장에서 “왜 Gemini인데 GPT도 쓰는가”를 이해하기 어렵던 상태를 먼저 문서와 코드 레이어로 정리했다.
- 동시에 개인 텔레그램 알림에서 종료된 장애가 계속 현재 문제처럼 올라오던 구조를 완화했다.

의사결정 이유:
- 전면 재설계보다 `플랫폼 기본`과 `앱 커스텀`의 경계를 먼저 드러내는 것이 내부 MVP와 운영 안정성에 더 유리하다.
- 오류 리뷰는 하루 누적과 현재 활성 상태를 분리해야 실제 장애 대응 우선순위를 올바르게 잡을 수 있다.

검증:
- `node --check bots/orchestrator/lib/jay-model-policy.js`
- `node --check bots/orchestrator/lib/intent-parser.js`
- `node --check bots/orchestrator/src/router.js`
- `node --check scripts/reviews/error-log-daily-review.js`
- `node scripts/reviews/error-log-daily-review.js --days=1 --json`

### 12주차 후속 (2026-03-18) — 워커 모니터링 + 투자 실행 모드 정합성 + 덱스터 경고 정리

핵심 구현:
- 워커 웹 관리자 메뉴에 `워커 모니터링` 추가
- `/admin/monitoring` 페이지에서 현재 워커 LLM API 적용 내용과 기본 provider 선택 드롭다운 추가
- `worker.system_preferences` 테이블 신설로 워커 웹 기본 LLM API 선택값 저장
- 워커 관리자 분석 경로(`/api/ai/ask`, `/api/ai/revenue-forecast`)가 선택한 provider를 우선 사용하도록 반영
- 투자팀 `executionMode` / `brokerAccountMode` 기준을 코드와 문서에 정리
- 투자 실패 원인 저장을 `block_reason + block_code + block_meta` 구조로 확장
- `weekly-trade-review.js`를 보조 입력 실패에 더 강인하게 보정
- 덱스터 `shadow mismatch`를 저위험 코드 무결성 이슈에서 `soft match`로 재해석해 과장 경고 정리

세션 맥락:
- 워커는 문서 재사용 추적 이후, 운영자가 실제 LLM 공급자 경로를 제어할 수 있는 관리 레이어까지 올라왔다.
- 투자팀은 자산과 직접 연결되는 실행 모드 의미를 다시 고정하면서 운영 리포트 해석 기준을 정리했다.
- 덱스터는 false positive를 줄여 실제 운영 경고만 남기도록 보정했다.

의사결정 이유:
- 워커 LLM 모니터링은 기존 `llm_mode` 정책을 깨지 않고, 관리자 분석 경로의 기본 provider만 별도 축으로 제어하는 것이 안전하다.
- 투자팀은 `paper/live`만으로는 자산/계좌 의미가 섞여서, `executionMode`와 `brokerAccountMode`를 분리하는 쪽이 운영과 SaaS 확장 모두에 유리하다.
- 덱스터는 `monitor`와 `ignore` 차이를 모두 오류로 올리면 운영 피로도가 커지므로, 저위험 dev-state는 완화해서 보는 것이 맞다.

검증:
- `node --check bots/worker/lib/llm-api-monitoring.js`
- `node --check bots/worker/lib/ai-client.js`
- `node --check bots/worker/web/server.js`
- `cd bots/worker/web && npm run build`
- `node bots/worker/scripts/health-report.js --json`
- `node bots/investment/scripts/trading-journal.js --days=7`
- `node bots/claude/scripts/health-report.js --json`

### 12주차 후속 (2026-03-18) — 스카 shadow 비교 + 워커 문서 재사용 추적

핵심 구현:
- 스카 예측 엔진에 `knn-shadow-v1` shadow 비교 모델 추가
- `forecast_results.predictions`에 `shadow_model_name`, `shadow_yhat`, `shadow_confidence` 저장
- 스카 일일/주간 리뷰가 `primary vs shadow` 비교를 읽도록 확장
- 스카 자동화 프롬프트를 shadow 관찰/승격 판단 기준으로 갱신
- 워커 문서 재사용 흐름에 문서 상세, 재사용 이벤트, 생성 결과 연결, 전환율 요약 추가
- 일일 운영 분석 리포트 입력 스크립트 `scripts/reviews/daily-ops-report.js` 추가 및 fallback 과장 진단 완화
- 구현 추적 문서를 `docs/PLATFORM_IMPLEMENTATION_TRACKER.md`로 이름 변경하고 세션 인덱스/팀 문서 링크 정리
- 세션 시작/종료 문서 흐름을 `SESSION_CONTEXT_INDEX.md`, `WORK_HISTORY.md`, `RESEARCH_JOURNAL.md` 중심으로 재정리

세션 맥락:
- 스카는 기존 엔진을 교체하지 않고 `shadow`로만 비교를 시작했다.
- 워커는 문서 파싱 기능을 넘어서 실제 업무 생성 결과와 성과를 추적하는 단계로 넘어갔다.
- 운영 분석은 과한 추론보다 보수적 판단을 우선하는 방향으로 입력 구조를 조정했다.

의사결정 이유:
- 스카는 내부 MVP와 운영 안정성을 위해 `대체`보다 `shadow 비교`가 맞다.
- 워커는 새 레이어를 만들기보다 기존 문서 저장/업무 confirm 흐름을 확장하는 것이 더 안전하다.
- 세션 문서는 같은 성격을 나누기보다 기존 문서에 흡수해 읽는 순서를 줄이는 것이 맞다.

검증:
- `python3 -m py_compile bots/ska/src/runtime_config.py bots/ska/src/forecast.py`
- `node --check scripts/reviews/daily-ops-report.js`
- `node --check scripts/reviews/ska-sales-forecast-daily-review.js`
- `node --check scripts/reviews/ska-sales-forecast-weekly-review.js`
- `cd bots/worker/web && npm run build`

### 10~11주차 (3/11~3/15) — 228개 커밋

핵심 구현:
- KST 시간 유틸리티 (packages/core/lib/kst.js) + 전 팀 적용 + launchd KST 수정
- KNOWN ISSUES 5개 개선 (mini 폴백 + screening DB + XSS + gemini maxTokens)
- CLAUDE.md 공통 원칙 8개 추가 (6대 원칙 + 노드화 + LLM + 보안)
- 소스코드 접근 권한 제한 (file-guard.js + 덱스터 화이트리스트)
- 루나 노드화 파이프라인 스캐폴딩 (debate + decision + risk + execution)
- 루나 스크리닝 강화 (해외 + 암호화폐 휴리스틱)
- 루나 매매일지 자동 리뷰 + 엑스커전 + 리스크 연동
- 스카 예측 캘리브레이션 + 피처스토어 + 모멘텀
- 워커 WebSocket 실시간 채팅 + 태스크 러너 + 승인
- 제이 인텐트 자동 프로모션 + 롤백 + 감사 추적
- 통합 OPS 헬스 (루나 리스크 + 스카 예측 + 클로드 품질 + 워커)
- 팀별 개별 헬스 리포트 (루나/스카/클로드/워커/블로)
- 공유 헬퍼 리팩터링 42개
- 블로그팀 plist Hour 수정 (UTC21→KST6) + 수동 발행 38강+홈페이지와App
- 워커 웹 모바일 버그 수정 (SSE→XHR, 툴칩 애니메이션, 채팅 중복 메시지)
- 워커 웹 클로드코드 채팅 메시지 버블 병합 (도구 실행 중 텍스트 하나로 합침)

---

### 빌링 버그 수정 + 오발동 수정 + 보안 업그레이드 (2026-03-13)

**빌링 합산 버그 수정**
- `bots/claude/lib/checks/billing.js`: API 누적값을 SUM으로 더해 $79.92 뻥튀기 → `DISTINCT ON (provider, date)`로 최신값만 합산
- 실제 금액 확인: $19.98 (Anthropic $16.42 + OpenAI $3.56), 월말 예상 $47.65

**완료 예약 허위 취소 오발동 수정**
- `bots/claude/lib/checks/ska.js`: 이용 완료 후 `cancelled_keys`에 dedup 키가 잔류해 매 체크마다 오발동
- 케이스 B(이용 완료 감지) 시 해당 키를 `cancelled_keys`에서 자동 정리하도록 수정

**Picco 취소 재시도 추가**
- `bots/reservation/auto/monitors/naver-monitor.js`: `runPickkoCancel` 실패 시 60초 후 1회 자동 재시도
- Playwright 타임아웃으로 인한 일시적 실패 자가복구 가능

**npm audit 워크스페이스 경로 + PATH 수정**
- `bots/claude/lib/checks/deps.js`: 모노레포 하위 패키지에 lock 파일 없어 audit 스킵되던 문제 해결
- 루트에서 `--workspace` 플래그로 실행, `execSync` env에 PATH 추가

**오정은 (010-7184-8299) 3/29 예약 manual 처리**
- `pickko_status`: `verified` → `manual` (픽코 수동 등록 완료)

**보안 패키지 업그레이드**
- ccxt 4.5.42 → 4.5.43
- bcrypt 5.1.1 → 6.0.0 (tar / node-pre-gyp high 취약점 해결)
- npm audit: 2 high → 0 vulnerabilities
- groq-sdk: Breaking change로 업그레이드 보류

**PATCH_REQUEST.md 처리 완료 후 삭제**

**덱스터 최종 상태**: ❌ 0건 / ⚠️ 2건 (경미, 시간 지나면 소멸)

---

### 덱스터 알람 개선 + 스카팀 LLM 교체 (2026-03-12)

**스카팀 LLM 교체**
- `bots/registry.json`: reservation/ska 모델 `gemini-2.5-flash` → `groq/llama-4-scout-17b-16e-instruct`, fallback `openai/gpt-4o-mini`
- deploy-context.js 재실행 → BOOT.md 반영 완료

**dexter_error_log upsert 방식으로 변경**
- `bots/claude/lib/error-history.js`: INSERT → ON CONFLICT DO UPDATE (occurrence_count 누적)
- `getPatterns()`: COUNT(*) → occurrence_count 컬럼 기준으로 변경
- DB 마이그레이션: 기존 106행 → unique constraint 추가 후 12행으로 정리

**dexter-quickcheck.js 알람 레벨 개선**
- failCount 기반 분기: 1회 실패 → ⚠️ alert_level 2 (경고), 2회+ 연속 → 🚨 alert_level 4 (CRITICAL)

**dexter.js 신규 오류만 텔레그램 발송**
- `bots/claude/src/dexter.js`: `hasIssue` → `hasCritical || newErrors.length > 0` 로 변경
- `getNewErrors` import 추가
- 효과: 반복 오류는 발송 안 하고, 최근 2시간 내 처음 등장한 오류 또는 CRITICAL만 알림

**naver-monitor.js 버그 수정 (이전 세션 연속)**
- 취소 성공 시 DB status 미업데이트 수정
- 취소감지4 OBSERVE_ONLY 필터 누락 수정

**체크섬 갱신**
- `bots/claude/.checksums.json`: 42개 파일 갱신

**LLM 속도 테스트 실행**
- groq/gpt-oss-20b 152ms 🥇, llama-3.1-8b 153ms 🥈 (현재 스카팀 llama-4-scout는 464ms로 6위)

### 전 팀 LLM 모델 최적화 + 스카팀 재가동 (2026-03-11)

**루나팀 llm-client.js v2.4 — 에이전트 라우팅 재배치**
- `GROQ_AGENTS`: `['nemesis', 'oracle']` (athena/zeus 제거)
- `MINI_FIRST_AGENTS` 신규: `['hermes', 'sophia', 'zeus', 'athena']` → gpt-4o-mini 메인 + scout 폴백
- `callOpenAIMini()` 함수 신규 추가
- `callGroq()` 폴백: gpt-4o → **gpt-4o-mini**로 변경 (비용 절감)

**블로그팀 LLM 폴백 체인 변경**
- `pos-writer.js`, `gems-writer.js`: 2순위 `gpt-oss-20b` → `gpt-4o-mini`
- `star.js`: 단일 chain → gpt-4o-mini + llama-4-scout 폴백 추가

**클로드팀 LLM 최적화**
- `claude-lead-brain.js`: LLM_CHAIN에서 `claude-sonnet-4-6` 제거 → `gpt-4o → gpt-4o-mini → scout`
- `archer/config.js`: OPENAI.model `gpt-4o` → `gpt-4o-mini`

**루나팀 스크리닝 장애 대응 인프라 (변경 7)**
- `screening-monitor.js` 신규: 연속 실패 횟수 추적 + 3회 이상 시 텔레그램 알림 (2h 중복 방지)
- `pre-market-screen.js`: `PRESCREENED_FILE`에 `crypto` 추가, `loadPreScreenedFallback()` 신규 (24h TTL RAG 폴백)
- `domestic.js`, `overseas.js`: 아르고스 성공 시 `savePreScreened()` 저장, 실패 시 RAG 폴백 → 없으면 빈 배열
- `crypto.js`: 동일 RAG 폴백 패턴 적용 (최후 폴백: config.yaml 기본 종목)

**스카팀 완전 재가동**
- 구 프로세스 정리: ska.js(22143), start-ops.sh(22637), naver-monitor.js(57001)
- Chrome SingletonLock 제거, 스테일 락 파일 정리
- kickstart: ska.commander(59200), naver-monitor(59205/59289), kiosk-monitor(59390/59398)
- kiosk-monitor 이전 exit 1 (02:10 Navigation timeout) → 재기동 후 정상

**체크섬 갱신**: `bots/claude/.checksums.json`

---

### API 빌링 추적 + 아처 비용 트렌드 리포트 (2026-03-10)

**덱스터 billing.js 체크 모듈 신규**
- Anthropic Admin API (`GET /v1/organizations/costs`) + OpenAI Usage API 월간 실비용 수집
- `claude.billing_snapshots` 테이블 자동 생성 (provider, date, cost_usd, UNIQUE(provider,date))
- 예산 초과(100%)/경고(80%) + 일일 급등(전일 대비 N배) 감지
- `dexter.js`에 `billing` 체크 모듈 등록

**llm-keys.js 확장**
- `getAnthropicAdminKey()`: `anthropic.admin_api_key` 또는 `ANTHROPIC_ADMIN_API_KEY` 환경변수
- `getBillingBudget()`: 예산 설정 (anthropic $50 / openai $30 / total $80 / spike_threshold 3.0)

**아처 비용 트렌드 리포트**
- `analyzer.js`: `buildBillingTrendSection()` 추가 — 최근 7일 일별 비용 테이블 + 월간 소진율/예상 월말 비용
- `reporter.js`: `buildMarkdownWithBilling()` 추가 — 아처 리포트에 💰 LLM 비용 트렌드 섹션 자동 삽입

**config.yaml 업데이트**
- `anthropic.admin_api_key` 필드 추가 (빈 값, 별도 설정 필요)
- `billing` 섹션 추가: budget_anthropic/openai/total, spike_threshold

**체크섬 갱신**: 35개 파일 갱신 (`bots/claude/.checksums.json`)

---

### 스카팀 취소감지1 더블체크 + 블로팀 품질 강화 (2026-03-10)

**스카팀 naver-monitor**
- 취소감지1 오동작(7건 자동취소) 긴급 수정
- pendingCancelMap 도입: 미래예약 사라짐 1차감지 → 1사이클 후 재확인, 2회 연속 미감지 시만 취소 실행
- 30분 만료 폴백 로직 추가

**블로팀 img-gen.js 신규**
- gpt-image-1 high quality 이미지 생성 (대표 1장 + 중간 1장)
- 젬스(일반 포스팅) 전용 적용, 포스(강의)는 이미지 없음
- output/images/ + 구글드라이브 자동 저장

**블로팀 publ.js 버그 수정 3가지**
- inPre 블록 미리셋 → 코드블록 내 일반 줄 처리 오류 수정
- `**bold**` → `<strong>` 변환 누락 수정
- 제목 첫 줄 중복 HTML 출력 방지

**블로팀 pos-writer.js 커리큘럼 제목 강제 준수**
- writeLecturePost / writeLecturePostChunked(A/B/C 그룹) 모두에 ★★★ 지시 추가
- "제목의 핵심 키워드를 그대로 다루어야 한다, 다른 기술로 대체 금지" 명시

**blog.curriculum 120강 ver2.2 전체 업데이트**
- 다운로드 파일 기준 전체 120강 제목 일괄 업데이트 (기존 120강 전부 변경)
- 35강: 데이터베이스 마이그레이션 → Redis 1 인메모리 DB 캐싱 전략으로 변경 등

**글자수 기준 최종 확정**
- 포스(강의): min 8,000자 / goal 9,000자
- 젬스(일반): min 7,000자 / goal 8,000자 (내부 이어쓰기 트리거 7,500자)
- gems-writer _THE_END_ 조건 제거 → 짧은 완성본도 이어쓰기 강제

**내일(2026-03-11) 발행 준비 완료**
- 35강: Redis 1 인메모리 DB 캐싱 전략 (9,292자, DB ID:27)
- 최신IT트렌드: AI와 최신 기술이 만들어가는 새로운 미래 (9,853자, DB ID:32, 이미지 2장)



## 2026-03-12
### 🔧 버그헌팅: 8건 수정 (취소감지4 오탐/중복/빌링/블로그)
- 블로그 이어쓰기 중복 방지 (800자 tail+재시작감지)
- blo.js 중복실행 early-exit
- naver-monitor kst 임포트 누락 수정
- FUTURE_SCAN_LIMIT 50→300 + 스킵 안전장치
- 픽코 취소 중복 doneKey 통합
- 완료예약 허위취소 슬롯종료시간 기준 변경
- 빌링 API timeout DB캐시 폴백
- 패턴이력 26건 삭제
<!-- session-close:2026-03-12:버그헌팅-8건-수정-취소감지4-오탐중복빌링블로그 -->

### ✨ 종목 범위 확대: CoinGecko+ApeWisdom+KIS순위+FNG 연동
- CoinGecko Trending 병합 (크립토 트렌딩 보너스 20%)
- ApeWisdom WSB 멘션 집계 (해외주식 보완)
- KIS volume-rank API (국내주식 1순위 소스)
- Alternative.me FNG 기반 max_dynamic 자동 조절
- 후보 풀 확대: 크립토 30→50, 동적 3→7/5/5
- 버그1 blo.js early-exit DB오류 오스킵 수정
- 버그2 ska.js kst 미사용 수정
<!-- session-close:2026-03-12:종목-범위-확대-coingeckoapewisdomkis -->

### ✨ 미추적 BTC 흡수·직접매수·USDT폴백 구현
- 미추적 BTC 흡수 (같은 심볼 BUY 신호)
- BTC 직접 페어 매수 _tryBuyWithBtcPair (ETH/BTC 등)
- USDT 폴백 _liquidateUntrackedForCapital
- CoinGecko·ApeWisdom·FNG Rate Limit 처리 추가
- 다음 세션: 자본관리 대공사 (BTC를 capital로 인식)
<!-- session-close:2026-03-12:미추적-btc-흡수직접매수usdt폴백-구현 -->

### ✨ 루나팀 BTC 자본 인식 대공사
- capital-manager: getUntrackedBtcUsd() 헬퍼 추가
- capital-manager: getAvailableBalance() = USDT + 미추적 BTC
- capital-manager: getAvailableUSDT() 리포팅 전용 분리
- capital-manager: getTotalCapital() BTC 포함
- capital-manager: getCapitalStatus() BTC 내역 추가
- hephaestos: 미추적 BTC 흡수 (같은 심볼)
- hephaestos: _tryBuyWithBtcPair() BTC 직접 페어 매수
- hephaestos: _liquidateUntrackedForCapital() USDT 폴백
<!-- session-close:2026-03-12:루나팀-btc-자본-인식-대공사 -->

### 🔧 report.js absorb/liquidate 사이드 알림 포맷 추가
- notifyTrade absorb·liquidate·buy·sell 사이드 이모지 분기
- memo 필드 텔레그램 출력 추가
<!-- session-close:2026-03-12:reportjs-absorbliquidate-사이드-알 -->

### 🔧 워커팀 웹 UI 모바일 버그 수정
- 모바일 메뉴바 닫힘(setCanvasLocked ReferenceError 제거)
- 세션 싱글탭(onTouchStart 빈핸들러+group-hover제거)
- 세션 전환 내용 섞임(캐시제거+activeSessionRef동기화)
- 페이지-드로어 스크롤 간섭(overscroll-contain+body.overflow)
- 툴칩 레벨 정렬(pl-9)
- 스크롤 이슈(overscroll-contain+touch-action)
<!-- session-close:2026-03-12:워커팀-웹-ui-모바일-버그-수정 -->

### 🔧 워커팀 웹 UI 모바일 버그 수정 완료
- setCanvasLocked ReferenceError 제거
- iOS 싱글탭(onTouchStart+group-hover제거)
- 세션전환 내용섞임(캐시제거+ref동기화)
- 스크롤 간섭(overscroll-contain)
- 체크섬 갱신 42개
<!-- session-close:2026-03-12:워커팀-웹-ui-모바일-버그-수정-완료 -->

### ✨ 워커웹 UI개선 및 매출데이터 정합성 수정
- DataTable 페이지네이션(10건/pageSize prop)
- 매출데이터 90일치 날짜오프셋 수정(daily_summary 기준 재입력)
- sales API TO_CHAR date 수정(KST오프셋 버그 해결)
- 3/10~3/11 스카 매출 신규 입력
- 문서관리 삭제버튼 btn-danger 통일
- 사이드바/헤더 높이 h-16 정렬
- DataTable 빈행 채우기 제거
<!-- session-close:2026-03-12:워커웹-ui개선-및-매출데이터-정합성-수정 -->

### 🔧 스타봇 BLOG_INSTA_ENABLED opt-out 수정
- blo.js BLOG_INSTA_ENABLED opt-in→opt-out(!=false) 수정
- 수동 누락 포스트 42(37강)·43(성장과성공) 스타 카드 재실행 완료
<!-- session-close:2026-03-12:스타봇-blog_insta_enabled-optout- -->

### ✨ 젬스 분량 보완 — 뉴스 분석 섹션 + 보너스 확률 상향
- IT 카테고리 뉴스 분석 섹션 추가(700자+, 최신IT트렌드·IT정보와분석·개발기획과컨설팅)
- 보너스 인사이트 확률 상향(0개40%→20%, 2개25%→40%)
- section-ratio body_1·body_2 기본값 1800→2000자
- MIN_CHARS_GENERAL 7500→8000, 목표 8000→9000자
- 시스템프롬프트 본론 최소글자 1500→2000자
<!-- session-close:2026-03-12:젬스-분량-보완-뉴스-분석-섹션-보너스-확률-상향 -->

### 🔧 워커웹 채팅 중복 메시지 수정
- isSendingRef 추가(동기 중복 전송 방지)
- loadMessages 경쟁 조건 수정(스트리밍 중 DB 덮어쓰기 방지)
- 어시스턴트 메시지 key={i}→key={g.key} 버그 수정
<!-- session-close:2026-03-12:워커웹-채팅-중복-메시지-수정 -->

## 2026-03-11
### ✨ 강의 인스타 페어링 + 캐시 실패방지 + launchd INSTA 환경변수 + 이미지 medium 품질
- runLecturePost 강의 인스타 콘텐츠 페어링 추가 (BLOG_INSTA_ENABLED)
- img-gen.js quality=high→medium (OPENAI_IMAGE_QUALITY 환경변수 제어)
- gems-writer.js+pos-writer.js 글자수 미달 시 캐시 저장 건너뜀 (실패 결과 캐시 방지)
- schedule.js BLOG_RUN_DATE 오버라이드 + _today() 함수 추가
- launchd ai.blog.daily.plist BLOG_INSTA_ENABLED=true 추가 + reload
- DB 수동 보정: category_rotation 35/5, publish_schedule 3/10 카테고리 수정
<!-- session-close:2026-03-11:강의-인스타-페어링-캐시-실패방지-launchd-ins -->

### ✨ 루나팀 국내외장 공격적 매매 전환 (2주 검증)
- luna.js MIN_CONFIDENCE/FUND_MIN_CONF 마켓별 객체 차등
- luna.js LUNA_SYSTEM_CRYPTO/STOCK + getLunaSystem() 분기
- luna.js 투표 폴백 완화 (주식 vote>=0&&conf>=0.3=BUY)
- nemesis.js NEMESIS_SYSTEM_CRYPTO/STOCK + getNemesisSystem() 분기
- nemesis.js RULES_CRYPTO/STOCK + getRules() 분기 (주식 MAX_ORDER_USDT 2000)
- nemesis.js evaluateSignal rules=getRules(signal.exchange) 전면 교체
- scripts/pre-market-screen.js 신규 (장전 아르고스 스크리닝 → JSON 저장)
- domestic.js 장전 스크리닝 우선 로드 + 보유 포지션 추가
- overseas.js 동일 패턴 적용
- launchd prescreen-domestic(KST 08:00)+prescreen-overseas(KST 21:00) 2개 신규
<!-- session-close:2026-03-11:루나팀-국내외장-공격적-매매-전환-2주-검증 -->

### ✨ 블로그팀 차기 강의 시리즈 자동 선정
- curriculum-planner.js 신규 (종료 7강 전 트리거, HN+GitHub 트렌드, LLM 후보 3개, generateCurriculum)
- 003-curriculum-tables.sql 마이그레이션 (curriculum_series 신규 + 기존 curriculum 확장)
- blo.js dailyCurriculumCheck() 매일 호출 + transitionSeries() 시리즈 자동 전환
- schedule.js curriculum-planner getNextLectureTitle 우선 조회 연동
- DB: curriculum_series 생성 (Node.js 시리즈 active) + 기존 120강 series_id 연결 완료
<!-- session-close:2026-03-11:블로그팀-차기-강의-시리즈-자동-선정 -->

### ✨ 전 팀 LLM 최적화 + 스크리닝 RAG 폴백 + 스카팀 재가동
- llm-client MINI_FIRST_AGENTS+callOpenAIMini
- pos/gems-writer gpt-4o-mini 폴백
- star.js scout 폴백
- claude-lead-brain sonnet 제거
- archer gpt-4o-mini
- screening-monitor.js 신규
- RAG 폴백 24h TTL
- 스카팀 kickstart 재가동
<!-- session-close:2026-03-11:전-팀-llm-최적화-스크리닝-rag-폴백-스카팀-재가 -->

### 🔧 제이 무응답 4종 버그 수정
- mainbot.js await 누락(items is not iterable)
- groupAllowFrom 미설정(그룹 메시지 드롭)
- OpenAI Groq rate limit → gemini 전환
- OpenClaw requireMention 기본값 변경 대응(groups.*.requireMention=false)
<!-- session-close:2026-03-11:제이-무응답-4종-버그-수정 -->

### 🔧 naver-monitor kst 누락 수정
- naver-monitor.js kst 임포트 누락 → 알람 전송 실패 수정
<!-- session-close:2026-03-11:navermonitor-kst-누락-수정 -->

### 🔧 젬스/포스 이어쓰기 중복 방지 + 중복실행 early-exit
- gems-writer.js 이어쓰기 800자 tail + LLM 재시작 감지
- pos-writer.js 동일 패턴 적용
- blo.js 모두 발행 완료 시 early-exit
<!-- session-close:2026-03-11:젬스포스-이어쓰기-중복-방지-중복실행-earlyexit -->

### 🔧 취소감지4 오탐 수정 — 스캔 한도 300으로 상향
- 취소감지4 FUTURE_SCAN_LIMIT 50→300 (이영화 3/28 B룸 오탐 취소 원인)
- 스캔 한도 도달 시 stale 감지 스킵 안전장치 추가
- 오탐 cancelled_key(cancelid
- 1169988950) DB 삭제
- 이영화 픽코 수동 재등록 완료
<!-- session-close:2026-03-11:취소감지4-오탐-수정-스캔-한도-300으로-상향 -->

## 2026-03-10

### 블로그팀 장문 출력 극대화 5가지 방법 적용

**Continue 이어쓰기 + _THE_END_ 마커 + exhaustive 키워드 + temperature 조정**
- `pos-writer.js`: Continue 패턴 (MIN 7,000자 미달 시 2차 호출), _THE_END_ 마커, exhaustive 키워드, temperature 0.75→0.82
- `gems-writer.js`: 동일 패턴, temperature 0.80→0.85
- `quality-checker.js`: MIN 강의 9,000 / 일반 5,000 / GOAL 강의 10,000 / 일반 7,000
- **테스트 결과**: 강의 10,225자 ✅ / 일반 5,500자 ✅

### 블로그팀 분할 생성(Chunked Generation) + llm-keys 폴백 + 글자수 튜닝

**분할 생성 완성**
- `packages/core/lib/chunked-llm.js` 신규: `callGemini` / `callGpt4o` / `chunkedGenerate`
- `pos-writer.js`: `writeLecturePostChunked()` 4청크 추가 (group_a~d, 각 1,500~2,000자)
- `gems-writer.js`: `writeGeneralPostChunked()` 3청크 추가 (group_a~c)
- `blo.js`: `BLOG_LLM_MODEL=gemini` 환경변수로 전체 파이프라인 Gemini 분할 생성 전환

**llm-keys 폴백 적용**
- `pos-writer.js`, `gems-writer.js`, `chunked-llm.js`: `process.env.OPENAI_API_KEY` → `getOpenAIKey()` 교체
- 키 조회 순서: `config.yaml` → 환경변수

**글자수 기준 튜닝 (실측 기반)**
- quality-checker MIN/GOAL: 강의 7,000/9,000 / 일반 4,500/7,000
- gems 시스템 프롬프트: 6,000 → 7,000자 / 목표 8,000 → 8,500자
- gems 유저 프롬프트: 본론 섹션 1,500 → 2,000자씩

**테스트 결과**: ✅ 강의 8,122자 / ✅ 일반 4,602자 통과

---

### ✨ 블로그팀 소셜봇 + 이미지 생성 완성
- N40/N42 Gemini→OpenAI(gpt-4o-mini) 전환
- N41 인스타 카드 gpt-image-1+sharp 한글 합성
- img-gen.js Nano Banana 메인+OpenAI High 폴백 신규 구현
- 이모지→AI 배경 힌트 전략(EMOJI_HINT 맵)
- llm-keys getGeminiImageKey() 추가
- llm-logger SQL timestamptz 수정
- gpt-oss-20b reasoning_effort:low 추가
- Gemini thinkingBudget:0 추가
<!-- session-close:2026-03-10:블로그팀-소셜봇-이미지-생성-완성 -->

### ✨ 동적 인사이트 4~6개 + 내부 링킹 과거만 + 소셜→스타
- bonus-insights.js 신규 (봇별 보너스 풀 + 랜덤 선택)
- section-ratio.js 신규 (섹션별 글자수 동적 배분, 보너스 순수 추가)
- social.js→star.js 이름 변경 + blo.js 참조 변경
- maestro.js bonusInsights+totalInsights 추가
- pos-writer.js 보너스 인사이트 지시 + 내부 링킹 과거만 Phase 1
- gems-writer.js 동일 패턴 적용
- richer.js searchRelatedPosts currentLectureNum 필터 추가
- registry.json blog-social→blog-star
<!-- session-close:2026-03-10:동적-인사이트-46개-내부-링킹-과거만-소셜스타 -->

### ✨ 일자별 발행 스케줄 + 테스트 정책 + 도서리뷰 실제 도서 기반
- publish_schedule 테이블 마이그레이션(002-publish-schedule.sql)
- schedule.js 신규 (getTodayContext/updateScheduleStatus/ensureSchedule 등)
- book-research.js 신규 (네이버 책API→Google Books→폴백 베스트셀러)
- gems-writer.js 도서리뷰 특별 프롬프트 블록 추가
- blo.js 스케줄 기반 오케스트레이션으로 전면 개편 (category-rotation→schedule.js)
<!-- session-close:2026-03-10:일자별-발행-스케줄-테스트-정책-도서리뷰-실제-도서-기 -->

## 2026-03-09

### 워커팀 Phase 4 AI 고도화 완료 + rag-system 잔재 제거 (`0bfaa70`~`a21ce69`)

**버그 수정 (이전 세션 이어)**
- `sophie.js`: `base_salary` 하드코딩 → DB 컬럼 참조
- `POST /api/payroll/calculate`: `companyFilter` 누락 추가
- `POST /api/schedules`, `POST /api/sales`: `companyFilter` 누락 추가
- Rate limit 핸들러 JSON 형식 수정, 한글 파일명 인코딩 수정
- `GET /api/projects/:id` 신규 추가, `DELETE /api/documents/:id` 신규 추가
- `pickko-daily-audit.js`: `await collectNaverKeys()` 누락 수정

**Phase 4: AI 자연어 질문 + 매출 예측**
- `lib/ai-client.js` 신규: `callLLM()` + `callLLMWithFallback()` (Groq 우선 → Haiku 폴백)
- `lib/ai-helper.js` 신규: SQL 생성/요약 프롬프트, `isSelectOnly()`, `isSafeQuestion()`
- `POST /api/ai/ask`: 자연어 → SQL → 실행 → RAG → 요약 파이프라인 (admin/master 전용)
- `POST /api/ai/revenue-forecast`: 90일 매출 → Groq 분석 → 30일 예측
- 감사 로그: `ai_question`, `ai_forecast` 자동 기록
- `web/app/ai/page.js` 신규: AI 질문 폼 + 예시 칩 + 데이터 테이블 + 매출 예측
- `Sidebar.js`: admin/master 전용 AI 분석 메뉴 추가
- launchd 키 관리: `start-worker-web.sh` 래퍼로 `config.yaml`에서 런타임 로드

**보안 강화**
- `isSafeQuestion()`: 입력 질문에 DELETE/DROP 등 차단 (입력 단계 차단)
- `isSelectOnly()`: 생성된 SQL SELECT 전용 검증 (이중 방어)

**rag-system 잔재 제거**
- `~/projects/rag-system/` 제거 (백업: `~/backups/rag-system-backup-20260309.tar.gz`)
- `scripts/migrate-rag.js` 삭제 (마이그레이션 완료)
- `network.js`, `migrate` 스크립트 3종, `llm-cache.js`, `rag-server.js` ChromaDB 주석 정리

**미완 — RAG 임베딩**
- OpenAI 쿼터 초과 → RAG store/search 실패 (try-catch로 조용히 무시)
- **맥미니 도착 후** Ollama `nomic-embed-text`로 전환 예정

### ✨ RAG 완성 + 에이전트 오케스트레이션 Phase 2 + 보안패치
- RAG pgvector 전 컬렉션 완성 (9곳 Node.js + 2곳 Python)
- 스카팀 Python RAG 클라이언트 rag_client.py 신규
- forecast.py + rebecca.py RAG 연동
- 에이전트 오케스트레이션 Phase 2 MessageEnvelope + trace_id + tool-logger
- 009 마이그레이션 tool_calls 테이블 + trace_id 컬럼
- multer CVE 보안패치 + 5개 패키지 minor 업데이트
<!-- session-close:2026-03-09:rag-완성-에이전트-오케스트레이션-phase-2-보안 -->

### ✨ 네메시스 Phase 3 R/R 최적화
- analyze-rr.js 신규 — 8가지 TP/SL 시뮬레이션+봇정확도+RAG저장
- nemesis.js getDynamicRR() ESM export 추가
- weekly-trade-review.js buildRRSection() 주간 R/R 섹션 통합
- package.json analyze-rr 스크립트 추가
<!-- session-close:2026-03-09:네메시스-phase-3-rr-최적화 -->

### ✨ 클로드팀 개선 5가지 + 스카팀 개선 4가지
- bot-behavior.js 신규(독터 루프+실패율+루나급속)
- doctor.js 복구실패 RAG 학습 + getPastSuccessfulFix
- claude-lead-brain.js Shadow 4단계(CLAUDE_LEAD_MODE 환경변수)
- 헬스 대시보드 포트3032(npm run health)
- deps.js 패치 티켓 자동생성
- 스카 커맨더 RAG 연동(searchPastCases+storeAlertContext)
- 예약 현황 대시보드 포트3031(npm run dashboard)
- forecast.py 동적 가중치(MAPE 역수 기반)
- weather.py classify_weather_impact(API 재호출 없음)
<!-- session-close:2026-03-09:클로드팀-개선-5가지-스카팀-개선-4가지 -->

## 2026-03-08 (계속)

### RAG 자동 수집 파이프라인 + 팀장 RAG 연동 완성 (커밋: `7630fc8`)

**구현 완료:**
- `reporter.js` — 덱스터 ERROR/WARN 점검 결과 → rag_operations 저장
- `doctor.js` — 독터 복구 성공 이력 → rag_operations 저장
- `archer.js` — 아처 주간 기술 보고 (patches/security/llm_api) → rag_tech 저장
- `luna.js` — 매매 신호 확정 → rag_trades 저장 + LLM 전 유사 신호 검색·주입
- `claude-lead-brain.js` — shadow_log 후 분석 결과 → rag_operations 저장 + LLM 전 유사 장애 검색·주입

**최종 자동 수집 파이프라인:**
```
✅ 매매 완료       → rag_trades      (luna.js)
✅ 독터 복구       → rag_operations  (doctor.js)
✅ 덱스터 CRITICAL → rag_operations  (reporter.js)
✅ 아처 기술 보고  → rag_tech        (archer.js)
❌ nightly git log → 제거 (아처와 중복, 불필요한 임베딩 비용)
```

**설계 원칙:** 모든 RAG 저장/검색은 try-catch + console.warn 보호 — 실패해도 본 로직 무영향

**테스트 결과: 20/21 PASS** (A-5 nightly git log → 불필요하여 의도적 미구현)

---

### ✨ 루나팀 개선 3/3 — 소피아+아리아 고도화
- 소피아 Fear&Greed Index 추가 (alternative.me, 1시간 캐시)
- 소피아 combineSentiment() 다중소스 통합 (커뮤니티0.5+FG0.3+뉴스0.2)
- 소피아 analyzeSentiment 5분 결과 캐시
- 아리아 CRYPTO_TIMEFRAMES 3→4개 확장 (15m/1h/4h/1d)
- 아리아 calculateAutoWeights() 변동성 기반 동적 가중치
- 아리아 DB 메타데이터에 weights 추가
<!-- session-close:2026-03-08:루나팀-개선-33-소피아아리아-고도화 -->

### ✨ 클로드팀 완전체 개선 + 루나팀 자본관리
- team-bus.js 에러핸들링(try-catch 0→15개)
- dexter-mode.js 에러핸들링 보강(5→16개)
- Phase2 agent_state DB 기반 팀장 무응답 감지
- Phase3 Emergency 폴백 직접복구(emergencyDirectRecover)
- 루나팀 자본관리 완전체(capital-manager.js 신규)
- 루나팀 신호 pending→approved 전환 버그 수정
- 헤파이스토스 SELL 바이낸스 실잔고 폴백
- reporter.js ROUND 타입 버그 수정
<!-- session-close:2026-03-08:클로드팀-완전체-개선-루나팀-자본관리 -->

### ✨ 워커팀 Phase 1 기반 구축 완료
- worker 스키마+4개 테이블
- bcrypt+JWT 인증
- 업체 격리 미들웨어
- REST API 서버(포트4000)
- 워커팀장 텔레그램 봇
- Web 로그인/대시보드
- launchd ai.worker.web 등록
<!-- session-close:2026-03-08:워커팀-phase-1-기반-구축-완료 -->

### ✨ Phase 3 소피/라이언/클로이 + OWASP 로그 + 웹 대시보드
- DB 마이그레이션 005 (6테이블)
- sophie.js 급여봇
- ryan.js 프로젝트봇
- chloe.js 일정봇
- OWASP logger.js (계정잠금/민감필드마스킹)
- server.js Phase 3 API 라우트
- payroll/page.js
- projects/page.js
- projects/[id]/page.js
- schedules/page.js
- Sidebar Wallet/FolderKanban/Calendar
- Dashboard 6카드
<!-- session-close:2026-03-08:phase-3-소피라이언클로이-owasp-로그-웹-대시 -->

## 2026-03-08

### 제이 자연어 능력 향상 v2.0 (커밋: `4c9efa1`)
- **intent-parser.js 전면 재작성**
  - Intent 36→53개 (+17개): shadow_report, shadow_mismatches, llm_cost, cache_stats, llm_graduation, dexter_report, dexter_quickcheck, doctor_history, analyst_accuracy, analyst_weight, trade_journal, trade_review, trade_performance, tp_sl_status, stability, telegram_status, unrecognized_report, promote_intent, chat
  - 신규 슬래시 명령: /shadow, /graduation, /stability, /journal, /performance, /unrec, /promote
  - CoT 2단계 + Few-shot 10개 예시 → LLM 프롬프트 품질 향상
  - `loadDynamicExamples()`: unrecognized_intents DB에서 5분 캐시로 동적 Few-shot 주입
  - 최종 폴백: unknown → chat (자유 대화 허용)
  - **버그 수정**: ska_query 패턴 bare `|통계` 제거 → "캐시 통계" 오매칭 방지
- **router.js 대규모 확장**
  - unrecognized_intents PostgreSQL 테이블 (claude 스키마) + `logUnrecognizedIntent()`, `buildUnrecognizedReport()`, `promoteToIntent()`
  - chat 폴백 2단계: TEAM_KEYWORDS regex → `delegateToTeamLead()` → `geminiChatFallback()`
  - 17개 신규 case 핸들러: Shadow 리포트, LLM 졸업, 투자 일지, 덱스터 즉시 실행 등
  - HELP_TEXT v2.0: 전체 명령 반영 + 자동학습 안내 섹션
- 테스트: 24/24 케이스 통과
- 체크섬 갱신 (9개 파일)

### OpenClaw 게이트웨이 설정 오류 수정
- **원인**: `~/.openclaw/openclaw.json`에 `agents.teamLeads` 미인식 키 → config 유효성 실패 → exitCode: 1 반복
- **수정**: `openclaw doctor --fix` → 키 자동 제거
- **패턴 이력 초기화**: OpenClaw 메모리 반복 패턴 8건 삭제
- **덱스터 결과**: ❌ 0건, ⚠️ 2건 (OpenClaw 메모리 518MB — 추이 관찰)

### 변경 파일
- `bots/orchestrator/lib/intent-parser.js` (전면 재작성)
- `bots/orchestrator/src/router.js` (대규모 확장)
- `~/.openclaw/openclaw.json` (코드 외 설정 파일)

---







### ✨ Phase 1 — 루나팀 전환판단 + LLM졸업실전 + 덱스터팀장봇연동
- shadow-mode.js getTeamMode/setTeamMode 추가
- luna-transition-analysis.js 신규
- router.js luna_confirm/luna_shadow/luna_analysis 케이스
- run-graduation-analysis.js 신규
- weekly-stability-report.js weeklyValidation 연동
- reporter.js emitDexterEvent (agent_events 이중경로)
- claude-lead-brain.js processAgentEvent/pollAgentEvents
- dexter.js emitDexterEvent+pollAgentEvents 연결
- processAgentEvent payload TEXT 파싱 버그 수정
- db-backup pg_dump 절대경로 버그 수정 (이전 세션 이어)
- pickko-daily-audit manualCount TDZ 버그 수정 (이전 세션 이어)
- 테스트 14/14 전체 통과
- 스카팀 매출 데이터 체크 (마이그레이션 타이밍 이슈, 정상화)
- 포캐스트 학습데이터 0일 오류 분석 (정상화)
- pickko-daily-audit+db-backup launchd exit 1 갱신
<!-- session-close:2026-03-08:phase-1-루나팀-전환판단-llm졸업실전-덱스터팀장 -->

## 2026-03-07
### ✅ Day 7 — 통합 테스트 + 1주차 마무리
- 통합 테스트 5개 카테고리 전체 통과 (State Bus / 덱스터+독터 / 매매일지 / 크로스팀 / LLM 인프라)
- 1주차 문서화 완료 (work-history / dev-journal / CHANGELOG / SESSION_HANDOFF)
- 안정화 기준선 v3.2.0 설정 (docs/TEST_RESULTS.md)
<!-- session-close:2026-03-07:day-7-통합-테스트-1주차-마무리 -->

### 🔧 오탐 근본 수정 + Day 6 검증 완료
- markResolved() 추가 (ok 복귀 시 error 이력 자동 삭제)
- dexter.js markResolved 호출 통합
- Day 6 검증 15/15 전체 통과
<!-- session-close:2026-03-07:오탐-근본-수정-day-6-검증-완료 -->

### ✨ Day 6 — 독터 + 보안 강화 + OPS/DEV 분리
- doctor.js 신규 (화이트리스트 5개, 블랙리스트 9개, doctor_log 테이블)
- mode-guard.js 신규 (ensureOps / ensureDev / runIfOps)
- deploy-ops.sh 신규 (배포 전 5단계 점검)
- scripts/pre-commit에 config.yaml 차단 추가
- security.js pre-commit 훅 설치/권한 점검 추가
- markResolved() 추가 (오탐 근본 수정 — ok 복귀 시 error 이력 자동 삭제)
<!-- session-close:2026-03-07:day-6-독터-보안-ops-dev-분리 -->

### ✨ Day 5 — OpenClaw 멀티에이전트 구조
- packages/core/lib/team-comm.js 신규 (팀장 간 소통, State Bus 기반)
- packages/core/lib/heartbeat.js 신규 (팀장 생존 확인 + 이벤트 폴링)
- openclaw.json agents.teamLeads 등록 (ska / claude-lead / luna)
- SOUL.md 3개 생성 (ska / claude-lead / luna — 팀장 페르소나)
<!-- session-close:2026-03-06:day-5-openclaw-멀티에이전트 -->

### ✨ PostgreSQL 단일 DB 통합 마이그레이션 완료 (Phase 5~6)
- forecast.py psycopg2 마이그레이션
- ska 스키마 PostgreSQL 초기화 (setup-db.py)
- duckdb npm 제거 (investment)
- better-sqlite3 npm 제거 (reservation,orchestrator)
- KI-003 취약점 해결 (npm audit 0)
- CHANGELOG v3.3.0
- KNOWN_ISSUES KI-003 해결
<!-- session-close:2026-03-07:postgresql-단일-db-통합-마이그레이션-완료- -->

### ✨ 3주차 구축 — 클로드(팀장) Sonnet Shadow + 장애주입 테스트 + LLM 졸업 엔진
- claude-lead-brain.js — Sonnet Shadow 판단 엔진 신규
- dexter.js Shadow 연동 + await 누락 수정
- scripts/chaos/ 장애 주입 5종 스크립트
- llm-graduation.js LLM 졸업 엔진 신규
- analyst-accuracy.js 분석팀 정확도 추적 신규 (ESM)
- Groq↔OpenAI 양방향 폴백 (skipFallback 무한루프 방지)
- 오류패턴분석 메타루프 수정
- pickko-verify process.exit(0) 누락 수정
<!-- session-close:2026-03-07:3주차-구축-클로드팀장-sonnet-shadow-장애주 -->

## 2026-03-06
### 🔧 미해결 알림 반복 + tool_code 누출 버그 수정
- pickko-alerts-resolve.js 신규 (수동 해결 CLI)
- CLAUDE_NOTES.md 처리완료 핸들러 추가
- CLAUDE_NOTES.md tool_code 누출 금지 규칙 추가
<!-- session-close:2026-03-06:미해결-알림-반복-tool_code-누출-버그-수정 -->

### ✨ Day 4 — 루나팀 매매일지 시스템
- trade-journal-db.js 신규 (5개 테이블 + DB함수)
- report.js notifyJournalEntry + notifyDailyJournal 추가
- hephaestos.js 매매일지 자동 기록 연동
- nemesis.js trade_rationale 자동 기록 연동
- schema_migrations v4 등록
- DuckDB 5개 신규 테이블 생성 확인
<!-- session-close:2026-03-06:day-4-루나팀-매매일지-시스템 -->

## 2026-03-05
### ✨ 출금지연제 자동예약 + 덱스터 Phase C
- 출금지연제 delay 감지·ETA 계산·Telegram 안내
- 자동 출금 예약(withdraw-schedule.json)
- 루나 커맨더 30초 폴링 자동 실행
- 덱스터 신규감지 중복버그 수정
- 신규감지 창 24h→8h
- 시간표시 UTC→KST
- --clear-patterns CLI
- batched 자동정리
- RAG 서버 optional 처리
<!-- session-close:2026-03-05:출금지연제-자동예약-덱스터-phase-c -->

### 🔧 덱스터 Phase C 버그수정 + 업비트 출금지연 자동예약
- deps.js cd→cwd 수정 (launchd PATH 오류)
- git 상태 패턴 저장 제외 (false positive)
- getNewErrors 중복 수정 (GROUP BY)
- node→process.execPath 수정 (code/database/ska.js)
- 업비트 출금지연제 자동예약 (luna-commander)
- 마스터 절대규칙 등록
- RAG 상세 로드맵 등록 (improvement-ideas)
<!-- session-close:2026-03-05:덱스터-phase-c-버그수정-업비트-출금지연-자동예약 -->

### 🔧 헬스체크 회복 로직 + 제이 할루시네이션 방지 + db-backup 수정
- health-check.js 회복 감지·알림·state 저장 로직 추가
- backup-db.js async 누락 수정
- intent-parser.js 스카 점검 패턴 추가
- TOOLS.md 제이 bot_commands 명령 테이블 + 할루시네이션 방지 경고 추가
- 전체 흐름 테스트 완료 (회복 알림 텔레그램 수신 확인)
<!-- session-close:2026-03-05:헬스체크-회복-로직-제이-할루시네이션-방지-dbback -->

### 🔧 취소 루틴 버그 수정 (블러/키 충돌)
- page.click(body)→Escape 키 수정(상세보기 블러 문제)
- toCancelKey bookingId 기반 개선(슬롯 재예약 키 충돌 방지)
- Detection4 cancel key 동일 개선
- 한송이 수동 픽코 취소 처리 완료
<!-- session-close:2026-03-05:취소-루틴-버그-수정-블러키-충돌 -->

### ✨ 루나팀 국내/국외 모의투자 배포
- 국내장 모의투자 활성화 (ai.investment.domestic)
- 국외장 서비스 확인 (ai.investment.overseas)
- 포트폴리오 프롬프트 심볼 환각 버그 수정 (luna.js)
- 덱스터 신호 exchange 불일치 감지 추가 (database.js)
- Claude API 크레딧 소비 원인 분석 (OpenClaw Gemini OAuth 만료→Haiku 폴백)
<!-- session-close:2026-03-05:루나팀-국내국외-모의투자-배포 -->

### ✨ LLM 토큰 이력 DB 기록 + 거래 일지 스크립트
- llm-client.js Groq/OpenAI 토큰·응답시간 DB 기록
- token-tracker.js duration_ms + gpt-4o 단가 추가
- token_usage 테이블 duration_ms 컬럼 추가
- scripts/trading-journal.js 신규 (매매일지 CLI)
<!-- session-close:2026-03-05:llm-토큰-이력-db-기록-거래-일지-스크립트 -->

### ✨ OpenClaw 업데이트 + 제이 RAG 연동 + e2e 데이터 정리
- OpenClaw 2026.2.26→2026.3.2 업데이트
- 제이 TOOLS.md RAG 검색 섹션 추가 (system_docs 12건 임베딩)
- state.db e2e 테스트 데이터 4건 삭제 (2099-01-01)
<!-- session-close:2026-03-05:openclaw-업데이트-제이-rag-연동-e2e-데이 -->

### 🔧 예약 시간 파싱 버그 수정 + OpenClaw 복구 + 덱스터 오탐 수정
- naver-monitor 정오 종료시간 파싱 버그 수정
- pickko-accurate 경로 버그 수정
- logs.js Rate Limit 오탐 수정
- OpenClaw gemini-2.5-flash 복원
- OpenClaw fallback#3 gpt-4o 추가
- start-gateway.sh 래퍼 스크립트 생성(groq 키 하드코딩 제거)
- state.db 오류 예약 수동처리
<!-- session-close:2026-03-05:예약-시간-파싱-버그-수정-openclaw-복구-덱스터 -->

### 🔧 스카 pickko-query/cancel-cmd 경로 누락 버그 수정
- CLAUDE_NOTES.md 명령 테이블 절대경로 수정
- pickko-query.js 및 pickko-cancel-cmd.js 경로 누락 원인 파악
<!-- session-close:2026-03-05:스카-pickkoquerycancelcmd-경로-누락- -->

## 2026-03-04 (세션 3)
### ✅ 제이↔클로드 통신·NLP자동개선·정체성유지 시스템 — 완료

**완료 항목:**
- **제이↔클로드 직접 통신**: `/claude`, `/ask` 슬래시 명령 → `ask_claude` bot_command → `claude -p headless` (5분 타임아웃)
- **LLM 명칭 일반화**: `parseGemini` → `parseLLMFallback`, `GEMINI_MODEL` → `LLM_FALLBACK_MODEL/PROVIDER` — LLM 교체 시 두 줄만 변경
- **NLP 4단계 파싱**: slash → learned → keyword → LLM fallback (소스 태그: 'slash'|'learned'|'keyword'|'llm')
- **NLP 자동개선 루프**: 미인식 명령 → `analyze_unknown` bot_command → Claude가 JSON 응답(user_response + 패턴) → `nlp-learnings.json` 저장 → intent-parser.js 5분 리로드
- **팀장 정체성 점검**: `identity-checker.js` — 제이가 6시간마다 3개 팀장 COMMANDER_IDENTITY.md 점검·자동 복원
- **팀원 정체성 점검**: 스카(4명) / 루나(10명) / 클로드(5명) 각 팀장이 6시간마다 bot-identities JSON 갱신
- **커맨더 정체성 능동 유지**: 각 커맨더 `BOT_IDENTITY` 하드코드 기본값 + `loadBotIdentity()` 시작 및 6시간 리로드 (LLM 없이 작동)

**커밋:** `010b944`, `bd155de`, `8ab4686`, `1b2e1e7`, `24702f5`

---

## 2026-03-04 (세션 2)
### ✅ 제이 중심 지휘 체계 구축 — 완료

**완료 항목:**
- 제이 LLM Groq → Gemini 2.5 Flash 교체 (`intent-parser.js`, `token-tracker.js`)
- 제이 OpenClaw 에이전트 전환 — IDENTITY/MEMORY/TOOLS/HEARTBEAT.md 전면 교체
- mainbot.js Telegram 폴링 제거 (알람 큐 처리 전용화)
- bot_commands 테이블 추가 (DB 마이그레이션 v4)
- 스카 커맨더 (`ska.js`) 신설 — `ai.ska.commander` launchd 등록
- 루나 커맨더 (`luna-commander.cjs`) 신설 — `ai.investment.commander` launchd 등록
- 클로드 커맨더 (`claude-commander.js`) 신설 — `ai.claude.commander` launchd 등록
- intent-parser.js: ska_query/ska_action/luna_query/luna_action/claude_action 인텐트 추가
- router.js: 각 팀 bot_commands 연동 핸들러 추가
- crypto.js: 거래 일시정지 플래그(luna-paused.flag) 체크 추가

**현재 지휘 체계:**
```
사장님(텔레그램) → 제이(OpenClaw) → bot_commands → 스카/루나/클로드 커맨더
                                  ← mainbot_queue ← 팀봇 알람
```

---

### ✨ 제이 중심 지휘 체계 + 루나팀 고도화
- 제이 OpenClaw 에이전트 전환
- mainbot.js Telegram 폴링 제거
- bot_commands 테이블 추가(v4)
- 스카 커맨더 신설(ai.ska.commander)
- 루나 커맨더 신설(ai.investment.commander)
- 클로드 커맨더 신설(ai.claude.commander)
- intent-parser 스카/루나/클로드 인텐트 추가
- router.js 팀장 명령 연동
- luna.js 아르고스 전략 컨텍스트 연결
- luna.js asset_snapshot 자동 기록
- nemesis.js 포지션 한도 불일치 수정
<!-- session-close:2026-03-04:제이-중심-지휘-체계-루나팀-고도화 -->

### ✨ 팀 기능 문서화 및 제이 NLP 고도화
- TEAMS.md 문서 작성
- 키워드 패턴 14→24개 확장
- Gemini 프롬프트 전면 개편
- /dexter·/archer 실제 실행 전환
- 루나팀 OpenAI gpt-4o 라우팅
- LLM 속도테스트 모델 목록 갱신
- OpenAI 키 갱신 및 o-시리즈 파라미터 수정
<!-- session-close:2026-03-04:팀-기능-문서화-및-제이-nlp-고도화 -->

### ✨ 제이↔클로드 통신·NLP자동개선·정체성유지시스템
- 제이↔클로드 직접 통신 채널 (ask_claude)
- NLP 자동개선 루프 (analyze_unknown → nlp-learnings.json)
- 팀장·팀원 정체성 주기적 점검 및 자동 학습
- 각 커맨더 LLM 없이 파일 기반 정체성 능동 유지
- LLM 명칭 일반화 (Gemini → LLM_FALLBACK)
<!-- session-close:2026-03-04:제이클로드-통신nlp자동개선정체성유지시스템 -->

## 2026-03-04 (세션 1)
### 🔄 루나팀 Phase 3 고도화 — 미완료 상태로 중단

**이전 세션(2026-03-03 심야)에서 작업된 내용 (미커밋 상태):**
- `bots/investment/shared/signal.js`: PAPER_MODE 통합 + 자산 보호 5원칙 (`checkSafetyGates`)
- `bots/investment/shared/db.js`: strategy_pool + risk_log + asset_snapshot 테이블 추가
- `bots/investment/team/luna.js`: 2라운드 토론 구조 (`runDebateRound`)
- `bots/investment/team/nemesis.js`: 보수화 프롬프트 + traceId + NEMESIS_SYSTEM 교체
- `bots/investment/team/argos.js`: 외부 전략 수집봇 구현 (Reddit r/algotrading + r/CryptoCurrency + r/stocks)

**남은 작업 (다음 세션에서 이어서):**
- TASK 4: `bots/investment/launchd/ai.investment.argos.plist` 생성 (6시간 주기)
- TASK 5: `aria.js` 장 시간 체크 — `analyzeKisMTF`/`analyzeKisOverseasMTF`에 장 시간 외 처리 추가
  - `isKisMarketOpen`, `isKisOverseasMarketOpen`은 이미 `shared/secrets.js`에 있음
  - `domestic.js`/`overseas.js`에서 이미 사용 중 → aria.js 내부에 추가는 이중체크 or 다른 의미일 수 있음
- TASK 7: launchd plist (argos + 기타 누락분)
- TASK 8: cost-tracker 텔레그램 리포트 함수 추가
- TASK 9: chronos.js ESM 전환 (현재 CommonJS `require` 사용)
- 전체 커밋

<!-- session-interrupted:2026-03-04:루나팀-phase3-고도화-미완료-중단 -->

### ⚙️ Phase 3 OPS 전환 + 투자 리포트 + 메모리 정리
- DuckDB WAL 버그 수정 (CHECKPOINT)
- E2E 테스트 전체 통과 (crypto/domestic/overseas)
- 암호화폐 PAPER_MODE=false OPS 전환
- LLM 정책 v2.2 Groq 전용
- reporter.js 투자 리포트 시스템
- MEMORY.md 350→179줄 압축
<!-- session-close:2026-03-04:phase-3-ops-전환-투자-리포트-메모리-정리 -->

### ✨ 메인봇(오케스트레이터) 구현 완료
- DB 마이그레이션(token_usage 포함)
- mainbot.js/router/filter/dashboard 구현
- 팀별 publishToMainBot 클라이언트(CJS/ESM)
- time-mode.js
- naver-monitor/signal/dexter 교체
- launchd plist
- docs/MAINBOT.md
<!-- session-close:2026-03-04:메인봇오케스트레이터-구현-완료 -->

### ♻️ 전체 봇 sendTelegram → publishToMainBot 전면 교체
- error-tracker.js 마지막 교체 완료
- dexter 체크섬 갱신 (9개 파일)
<!-- session-close:2026-03-04:전체-봇-sendtelegram-publishtomai -->

### ✨ 메인봇 문서화 + time-mode 연동 + 전체 sendTelegram 교체 완료
- MAINBOT.md 최신화
- team-features.md 메인봇 OPS 상태 반영
- MEMORY.md 시스템 상태 업데이트
- time-mode.js crypto.js 연동
- manual scripts 교체 (pickko-revenue-confirm, e2e-test)
<!-- session-close:2026-03-04:메인봇-문서화-timemode-연동-전체-sendtel -->

### ✨ API 문서 분석 기반 개선사항 적용
- parse_mode HTML 추가 (telegram.js + mainbot.js)
- 4096자 메시지 분할 로직 (mainbot.js)
- LLM_DOCS.md 업데이트 (Telegram 9.5 + Groq 신모델 + OpenClaw + Claude 자동 캐싱)
<!-- session-close:2026-03-04:api-문서-분석-기반-개선사항-적용 -->

### ✨ LLM키통합+알람버그수정+덱스터패턴학습
- packages/core/lib/llm-keys.js 공용 LLM 키 로더
- mainbot_queue 무한반복 알람 버그 수정
- 덱스터 mainbot_queue 건강 체크 추가
- 덱스터 오류 패턴 학습 시스템 (dexter_error_log)
<!-- session-close:2026-03-04:llm키통합알람버그수정덱스터패턴학습 -->

## 2026-03-03
### ✨ 루나팀 OPS 전환 + 실행 체인 버그 수정
- **네이버 뉴스 API 등록**: 헤르메스 국내주식 뉴스 수집 활성화 (25,000 call/day)
  - config.yaml `news.naver_client_id/secret` 설정, 10건 뉴스 수집 확인
- **덱스터 DuckDB 읽기전용 수정**: database.js 체크 스크립트에 `READ_ONLY` 모드 추가
  - ai.invest.pipeline 실행 중 DuckDB 락 충돌 해소
- **루나팀 전체 테스트**: crypto/domestic/overseas 3사이클 전 통과
- **크립토 OPS 전환**: `ai.investment.crypto` PAPER_MODE=true → false (2026-03-03)
  - launchd plist 수정 + 재로드, `🔴 PAPER_MODE=false` LIVE 모드 확인
- **시그널 실행 체인 버그 수정** (커밋 `9390f7e`):
  - Bug 1: 헤파이스토스가 `getPendingSignals` 사용 → 네메시스 승인 후 `approved` 조회 안됨
    → `getApprovedSignals()` 추가, 헤파이스토스 전환
  - Bug 2: 네메시스 조정 금액($100)이 DB에 미반영 → 헤파이스토스가 원본 $2000 사용
    → `updateSignalAmount()` 추가, 네메시스에서 승인 시 호출
- **ETH → USDT 전환**: 바이낸스 ETH 0.0681 전량 매도 → $138.10 USDT 확보 (avg $2,028.94)
  - 크립토 봇 실거래 자금 확보 ($100 BUY 주문 가능)
<!-- session-close:2026-03-03:루나팀-ops전환-실행체인버그수정 -->

### ✨ 스카팀 운영관리 고도화 v3.0
- **Phase A: 폴더 구조 개편** — bots/reservation/src/ 27개 파일 → auto/manual 계층 구조 재편 (git mv)
  - auto/monitors/: naver-monitor(앤디), pickko-kiosk-monitor(지미) + 래퍼 sh
  - auto/scheduled/: daily-summary/audit/pay-scan + 래퍼 sh
  - manual/reservation/: pickko-accurate/cancel/register/query
  - manual/admin/: pickko-member/ticket/verify
  - manual/reports/: occupancy/alerts/stats/revenue/pay-pending
  - src/ 잔류: 진단·테스트 9개 파일
  - launchd plist 8개 경로 업데이트 + 재로드 (exit 127 전부 해소)
- **Phase B: 에이전트 통신 구축** — lib/state-bus.js + migrations/003_agent_state.js
  - agent_state 테이블: 에이전트 상태 공유 (idle/running/error)
  - pickko_lock 테이블: 픽코 어드민 단독접근 뮤텍스 (TTL 5분)
  - pending_blocks 테이블: 앤디→지미 블록 요청 큐
  - 앤디: 사이클 시작→running, 완료→idle, 오류→error 전환
  - 지미: acquirePickkoLock + finally 블록에서 idle 전환 + 락 해제
  - 수동(pickko-accurate): acquirePickkoLock('manual') + process.once('exit') 자동 해제
- **Phase C: 덱스터 ska 감시** — bots/claude/lib/checks/ska.js (5개 체크)
  - DB 존재, agent staleness(10분warn/30분error), pickko 데드락, 큐 적체, 앤디 마지막 성공
  - dexter.js: bots→ska→logs 순서로 등록
- **버그 수정**: state-bus updateAgentState 파라미터 순서 오류 (last_success_at↔last_error 뒤바뀜)
- **버그 수정**: pickko-kiosk-monitor 조기리턴 경로에서 jimmy 'running' 잔존 → finally 블록으로 이동
- 테스트: 폴더구조/state-bus(9케이스)/kiosk-monitor DEV 실행/덱스터 ska 전체 통과
- 루나팀 + 스카팀 launchd 정지 → 테스트 → 재시작
<!-- session-close:2026-03-03:스카팀-고도화-v3.0 -->

### ✨ 클로드팀 고도화 v2.0 (커밋 `3956782`)
- **Axis 1 — 덱스터↔아처 팀 통신 버스**:
  - `migrations/001_team_bus.js`: `~/.openclaw/workspace/claude-team.db` 스키마 (4테이블)
    - `agent_state`: 에이전트 상태 공유 (idle/running/error), `messages`: 에이전트 간 메시지 큐
    - `tech_digest`: 아처 기술 소화 이력, `check_history`: 덱스터 체크 실행 이력
  - `lib/team-bus.js`: 에이전트 상태·메시지큐·기술소화이력·체크이력 API
  - `scripts/migrate.js`: DB 마이그레이션 러너
  - `scripts/team-status.js`: 팀 상태 대시보드 콘솔 (`npm run status`)
  - `src/dexter.js`: team-bus 연동 — 시작/체크이력/완료 상태 자동 기록
- **Axis 2 — 아처 역할 재정의 (AI/LLM 트렌드 + 패치업 오케스트레이터)**:
  - `lib/archer/config.js`: MARKET 제거, WEB_SOURCES 추가 (Anthropic뉴스/OpenAI/HuggingFace/arXiv/The Batch), GitHub 12개·npm 7개
  - `lib/archer/fetcher.js`: 시장/봇 함수 제거, `fetchWebSource(RSS)` + `runNpmAudit` 추가
  - `lib/archer/analyzer.js`: buildContext 재작성, SYSTEM_PROMPT AI/LLM 패치 집중 (patches/security/llm_api/ai_techniques/web_highlights)
  - `lib/archer/patcher.js` (신규): `savePatchTickets` + `savePatchRequest(PATCH_REQUEST.md)` + `sendTelegram`
  - `lib/archer/reporter.js`: market/bots 섹션 제거, patch/audit/llm_api/ai_techniques/web_highlights 추가
  - `src/archer.js`: team-bus + patcher 연동
  - `scripts/patch-status.js` (신규): 패치 현황 콘솔 (`npm run patch:status`)
- **인프라**:
  - `package.json`: 11개 scripts (dexter:fix/daily + archer/archer:telegram/fetch-only + migrate/status/patch:status)
  - `CLAUDE.md` (신규): PATCH_REQUEST.md 처리 규칙 + 팀버스 섹션 (세션 시작 시 자동 로드)
  - `bots/registry.json`: archer dataSources v2.0 업데이트
- **검증**: 마이그레이션 ✅ / team-bus CRUD ✅ / 덱스터+team-bus ✅ / 아처 --fetch-only ✅ (GitHub 12개·npm 7개·웹소스 5개·audit 5건)
<!-- session-close:2026-03-03:클로드팀-고도화-v2.0 -->

## 2026-03-02
### ✨ Phase 3 E2E 테스트 + 아리아 안정성 개선
- 루나팀 Phase 3 전 사이클 E2E 테스트 완료: crypto(8.4초) / domestic(4.3초) / overseas(5.9초)
- 바이낸스 fetchOHLCV 재시도 로직: 일시 API 장애 대응 (1s·2s 지수 백오프, max 2회 재시도)
- BB 판정 버퍼존 도입: 절대값 비교 → 범위 비율(0~1) 기준 상단 95%↑/하단 5%↓ 임계값
  - 005930 삼성전자 BB 99% 위치 → 신뢰도 0%→20% 개선 (점수 0.00→-1.00)
- 덱스터 bots.js: `ai.investment.crypto/domestic/overseas` 3개 서비스 모니터링 추가
- registry.json: `investment` 항목 신규 등록 — Phase 3-A/B 팀원 12명 + 마켓 3종
<!-- session-close:2026-03-02:phase3-e2e-테스트-아리아-안정성-개선 -->

### ✨ Phase 3-B 국내외주식 사이클 구현 완료
- aria.js: Yahoo Finance OHLCV + analyzeKisMTF(일봉65%/1h35%) + analyzeKisOverseasMTF(일봉60%/1h40%)
- domestic.js: 국내주식 30분 사이클 (아리아·헤르메스·소피아·루나·한울 파이프라인 완성)
- overseas.js: 미국주식 30분 사이클 (동일 파이프라인, kis_overseas exchange)
- cost.daily→cost.usage 버그 수정 (crypto.js·domestic.js·overseas.js 3개)
- launchd: ai.investment.domestic + ai.investment.overseas 등록 (5분 주기, PAPER_MODE=true)
- 테스트: domestic --force (삼성전자·SK하이닉스) 5.3초 완료 / overseas --force (AAPL·NVDA) 5.1초 완료
<!-- session-close:2026-03-02:phase3b-국내외주식-사이클-구현-완료 -->


### ✨ SKA-P05~P08 루나팀 패턴 적용 + deploy-ops.sh
- lib/error-tracker.js 연속 오류 카운터 (naver-monitor+kiosk-monitor 통합)
- scripts/e2e-test.js E2E 통합 테스트 28/28
- lib/mode.js DEV/OPS 모드 분리 (MODE=ops, getModeSuffix)
- lib/status.js 프로세스 상태 파일 /tmp/ska-status.json
- scripts/deploy-ops.sh E2E→컨펌→OPS재시작→체크섬→텔레그램
<!-- session-close:2026-03-02:skap05p08-루나팀-패턴-적용-deployopss -->

### ✨ 3중 가동/중지 lib/health.js + deploy-ops.sh
- lib/health.js 3중 가동(preflightSystemCheck/ConnCheck)+3중 중지(shutdownDB/Cleanup/registerShutdownHandlers)
- scripts/preflight.js health.js 래퍼로 교체
- src/start-ops.sh 3중 체크 추가(--conn)
- src/naver-monitor.js registerShutdownHandlers+isShuttingDown 루프 가드
- scripts/e2e-test.js 32/32 통과
<!-- session-close:2026-03-02:3중-가동중지-libhealthjs-deployopss -->

### ✨ 하트비트 오늘예약현황 추가 + scar→ska 정리 + 절대규칙 등록
- getTodayStats() DB함수 추가 (네이버+키오스크 합계)
- 하트비트 메시지 오늘 예약현황 섹션 추가
- etl.py scar.duckdb→ska.duckdb 주석 수정
- 이브(Eve) 절대규칙 스카팀 등록 + registry.json 추가
- 절대규칙 기본언어 한국어 추가
<!-- session-close:2026-03-02:하트비트-오늘예약현황-추가-scarska-정리-절대규칙 -->

### ✨ OpenClaw 공식문서 검토 + 속도테스트 프로바이더 등록 + LLM_DOCS Cerebras/SambaNova 추가
- 루나팀 분석가 프로바이더 분산(onchain→cerebras, sentiment→sambanova)
- 루나팀 LLM 후보군 등록(llm-candidates.json + speed-test --luna)
- OpenClaw 공식문서 검토 및 개선 항목 분류
- LLM_DOCS.md Cerebras/SambaNova 섹션 추가(§4·§5)
- 즉시 조치 3개(NVM path 수정·보안감사·세션정리)
- 속도테스트기 5개 프로바이더 추가(xai/mistral/together/fireworks/deepinfra)
- improvement-ideas.md OpenClaw 개선 백로그(OC-001~009) 추가
<!-- session-close:2026-03-02:openclaw-공식문서-검토-속도테스트-프로바이더-등 -->

### ✨ OpenClaw OC-001~009 보안·설정 개선 전체 완료
- OC-001 qwen CRITICAL 제거(fallbacks에서 제거)
- OC-002 denyCommands 무효 6개→canvas.eval 교체
- OC-003 botToken→tokenFile 파일 분리(chmod 600)
- OC-004 ackReaction 👀 활성화(scope:all + removeAckAfterReply)
- OC-005 session.reset daily 새벽3시
- OC-006 session.dmScope per-channel-peer
- OC-007 멀티에이전트 스킵(루나팀 standalone)
- OC-008 include분리 스킵(불필요)
- OC-009 configured,missing 3개 모델 제거
<!-- session-close:2026-03-02:openclaw-oc001009-보안설정-개선-전체-완 -->

### ✨ 루나팀 다중심볼+KIS통합강화
- 절대규칙 업데이트(루나팀=암호화폐·국내외주식)
- LU-020 다중심볼 BTC/ETH/SOL/BNB getSymbols()
- LU-021 KIS 6지표 풀분석(이평정배열/스토캐스틱/ATR/거래량)
- isKisMarketOpen() 장중필터(09:00~15:30 KST)
- signal-aggregator 코인+KIS 통합 파이프라인
<!-- session-close:2026-03-02:루나팀-다중심볼kis통합강화 -->

### ✨ registry.json 현황 업데이트 + KIS Yahoo폴백
- registry.json 루나팀 실제 상태 반영(온체인·뉴스·감성 dev로 정정)
- registry.json 제이슨 파이프라인 상세 명시(6지표·3TF·4심볼)
- registry.json model/logFile/launchd 실제값 반영
- KIS fetchOHLCV Yahoo Finance 폴백(150개 이력, MACD·MA60·MA120 활성화)
<!-- session-close:2026-03-02:registryjson-현황-업데이트-kis-yahoo -->

### ✨ LU-035리서처+LU-024리포터+ETH실매수
- LU-035 강세/약세 리서처 signal-aggregator 통합 완성
- LU-022/024 성과 리포트 reporter.js 구현 (일/주/월, launchd 22:00)
- ETH/USDT 0.0682 실거래 매수 (.25)
- 맥북 개발 방침 확정 + 개발 우선순위 재조정 문서 반영
<!-- session-close:2026-03-02:lu035리서처lu024리포터eth실매수 -->

### ✨ 취소 감지 교차검증 + KIS 구현 + LLM 비용 최적화
- naver-monitor.js 취소 감지 교차검증: 감지 2 먼저 실행 → currentCancelledList → 감지 1 교차검증 (이용완료 오탐 방지)
- KIS lib/kis.js qty<1 버그 수정 (dryRun 분기 앞으로 이동)
- fund-manager.js: sonnet-4-6 → haiku-4-5-20251001, max_tokens 2048→1024, timeout 30s→20s
- signal-aggregator.js: MAX_DEBATE_SYMBOLS=2 추가 (debate 최대 2심볼/실행, API 비용 절감)
- launchd 스케줄 최적화: ai.invest.dev 5분→10분, ai.invest.fund 30분→60분
- SYSTEM_DESIGN.md + work-history.md 전체 업데이트
<!-- session-close:2026-03-02:취소감지교차검증-kis구현-llm비용최적화 -->

### ✨ LU-030펀드매니저+LU-036리스크매니저v2
- LU-030 fund-manager.js — sonnet-4-6 포트폴리오 오케스트레이터 (30분 launchd)
- LU-036 risk-manager.js v2 — ATR변동성·상관관계·시간대·LLM haiku 4단계 조정
- registry.json 펀드매니저·리포터 서브봇 등록
<!-- session-close:2026-03-02:lu030펀드매니저lu036리스크매니저v2 -->

### ✨ LU-037-백테스팅엔진
- LU-037 scripts/backtest.js — TA전략 역사적 검증 엔진
- 4개 심볼 1d/4h 백테스트 + 텔레그램 발송
- 인사이트: SOL/BNB 수익팩터 2.0 수준 / BTC/ETH 하락장 TA진입 취약
<!-- session-close:2026-03-02:lu037백테스팅엔진 -->

### ✨ LU-038 몰리 v2 TP/SL 모니터 구현 완료
- upbit-bridge.js에 checkTpSl() 함수 추가 (진입가±3% 자동 청산)
- ai.invest.tpsl launchd 등록 (5분 주기 DRY_RUN)
- marketSell + db 연동 + 텔레그램 알림
- 드라이런 테스트 통과 (BTC/USDT -2.03% SL 조건 미달 정상)
<!-- session-close:2026-03-02:lu038-몰리-v2-tpsl-모니터-구현-완료 -->

### ✨ CL-004 Dev/OPS 분리 구현 완료
- mode.js getModeSuffix() 추가 (DEV:-dev / OPS:'')
- health.js STATUS_FILE 동적화 (/tmp/invest-status-dev.json vs invest-status.json)
- dexter bots.js 루나팀 5개 서비스 + DEV/OPS 상태 분리 체크
- switch-to-ops.sh 전환 체크리스트 스크립트 신규
- dry_run=false 위험 감지 → true 복구
<!-- session-close:2026-03-02:cl004-devops-분리-구현-완료 -->

### ✨ 아처-리포트-봇팀-현황-섹션-추가
- fetcher.js fetchLunaStats+fetchSkaStats 추가
- reporter.js 루나팀/스카팀 섹션 추가
- analyzer.js buildContext 봇 데이터 통합
- 덱스터 체크섬 갱신
<!-- session-close:2026-03-02:아처리포트봇팀현황섹션추가 -->

### ✨ 대리등록-네이버-예약불가-자동처리-로직-추가
- pickko-kiosk-monitor.js blockSlotOnly() + --block-slot 모드 추가
- pickko-register.js 픽코 등록 성공 후 네이버 차단 자동 호출
- 오수정님 테스트 통과 (이미 차단됨 감지)
<!-- session-close:2026-03-02:대리등록네이버예약불가자동처리로직추가 -->

### ✨ 오늘-예약-검증-audit-today-구현
- auditToday() 함수 추가 (pickko-kiosk-monitor.js)
- getKioskBlocksForDate(date) DB 함수 추가 (lib/db.js)
- --audit-today 진입점 추가
- run-today-audit.sh 래퍼 스크립트 생성
- ai.ska.today-audit.plist 08:30 KST launchd 등록
<!-- session-close:2026-03-02:오늘예약검증audittoday구현 -->

### 🔧 auditToday-failedList-차단실패-알림-추가
- blockNaverSlot false반환시 DB false positive 방지 확인
- auditToday failedList 추가 - 차단실패 텔레그램 알림
- 덱스터 체크섬 갱신
<!-- session-close:2026-03-02:audittodayfailedlist차단실패알림추가 -->

### 🔧 blockNaverSlot-avail소멸-보조확인-차단성공
- verifyBlockInGrid suspended만 확인하는 한계 발견
- blockNaverSlot avail 소멸 보조 확인 추가 (예약가능설정 방식 차단 지원)
- B룸 18:00 차단 성공 확인
<!-- session-close:2026-03-02:blocknaverslotavail소멸보조확인차단성공 -->

### ✨ audit-date-내일날짜-검증-완료
- auditToday dateOverride 파라미터 추가
- --audit-date=YYYY-MM-DD CLI 옵션 추가
- 내일(03/03) 고아차단 해제 흐름 검증 완료
<!-- session-close:2026-03-02:auditdate내일날짜검증완료 -->

### ✨ 픽코취소-네이버해제-자동화-unblock-slot
- unblockNaverSlot avail-gone 버그 수정 (false positive return 제거)
- restoreAvailGoneSlot 헬퍼 추가 (B룸 예약가능설정방식 복구)
- unblockSlotOnly + --unblock-slot CLI 모드 추가
- pickko-cancel-cmd.js: 픽코취소→네이버해제 자동 2단계 실행
<!-- session-close:2026-03-02:픽코취소네이버해제자동화unblockslot -->

### 🔧 취소-테스트-성공-avail-gone-복구-확인
- 이승호 B룸 18:00 취소 테스트 성공 (픽코취소+네이버해제)
- avail-gone 방식 복구 확인 (restoreAvailGoneSlot 정상 작동)
<!-- session-close:2026-03-02:취소테스트성공availgone복구확인 -->

### ✨ 예약 취소 E2E 완성 + TOOLS.md 취소/등록 도구 정비
- pickko-cancel-cmd.js 2단계 취소(픽코+네이버 해제) 완성
- avail-gone 방식 unblockNaverSlot 수정 + restoreAvailGoneSlot 구현
- --block-slot --unblock-slot --audit-date CLI 추가
- TOOLS.md 취소 섹션 추가 + pickko-accurate.js 내부모듈 명시
- 취소+등록 E2E 스카봇 자연어 테스트 통과
<!-- session-close:2026-03-02:예약-취소-e2e-완성-toolsmd-취소등록-도구-정 -->

### ♻️ 봇 이름 변수화 완료
- dexter.js/reporter.js/autofix.js BOT_NAME='덱스터' 상수 추가
- archer.js/archer/reporter.js BOT_NAME='아처' 상수 추가
- kis-executor.js BOT_NAME='크리스' 상수 추가
- 덱스터 체크섬 갱신 9개 파일
<!-- session-close:2026-03-02:봇-이름-변수화-완료 -->

### ✨ 루나팀 Phase 3-A v2.1 — bots/investment/ 신규 아키텍처 구현
- **bots/investment/ 디렉토리 전체 신규 생성** (ESM "type":"module")
- shared/ 5개 모듈: llm-client.js(통합LLM) + db.js(DuckDB) + signal.js + secrets.js(config.yaml) + report.js + cost-tracker.js
- team/ 9개 에이전트: aria(MTF TA) + oracle(온체인) + hermes(뉴스) + sophia(감성+xAI) + zeus(강세) + athena(약세) + nemesis(리스크) + luna(오케스트레이터) + hephaestos(바이낸스) + hanul(KIS)
- markets/ 3개 사이클: crypto.js(30분 throttle+BTC±3% 긴급트리거) + domestic.js(스켈레톤) + overseas.js(스켈레톤)
- **callLLM(agentName, system, user, maxTokens)** 통합 — PAPER_MODE=true→전원 Groq Scout, LIVE→luna+nemesis Haiku 4.5
- config.yaml 도입 (secrets.json 폴백), cost-tracker.js BUDGET_EXCEEDED EventEmitter
- npm 의존성: @anthropic-ai/sdk + groq-sdk + ccxt + js-yaml + axios (36 packages)
- node --check 20개 파일 전체 통과
- launchd ai.investment.crypto: 5분 주기(내부 30분 스로틀), BTC 긴급 트리거
<!-- session-close:2026-03-02:루나팀-phase3a-v21-bots-investment-신규아키텍처 -->

## 2026-03-01
### 🔧 새로고침 버튼 fix + 알림 컨텍스트 공유
- naver-monitor 새로고침 버튼 ElementHandle.click→evaluate() 수정
- pickko-alerts-query.js 신규 (알림 DB 조회 CLI)
- CLAUDE_NOTES.md 알림 인식 규칙 추가 (방금 알림 키워드 트리거)
- deployer.js BOOT.md 생성 시 최근 48시간 에러 알림 자동 인라인
<!-- session-close:2026-03-01:새로고침-버튼-fix-알림-컨텍스트-공유 -->

### 🔧 ETL actual_revenue 입금 기준 전환 + pickko_total 분석
- ETL actual_revenue: pickko_total(이용일) → total_amount(입금일) 기준 전환
- studyroom_revenue = total_amount - general_revenue 로 재계산
- DuckDB 02/28 수동 수정 (236,000→319,500)
- ETL 즉시 재실행 — 91건 upsert, 02/27·02/28 정상화
<!-- session-close:2026-03-01:etl-actual_revenue-입금-기준-전환-pi -->

### 🔧 BOOT 침묵 규칙 통일 + ETL total_amount 기준 변경
- BOOT.md 메시지 전송 규칙 제거(침묵 대기로 통일)
- ETL actual_revenue를 total_amount 기준으로 변경
- DuckDB 02/28 actual_revenue 수동 수정(319,500)
- naver-monitor 새로고침 버튼 click 타임아웃 수정
- pickko-alerts-query.js 신규 생성
- deployer.js BOOT 에러 알림 인라인 추가
<!-- session-close:2026-03-01:boot-침묵-규칙-통일-etl-total_amount -->

### 🔧 미컨펌 알림 날짜 버그 수정
- 미컨펌 알림 범위 최근 3일 이내로 제한
- 메시지 '어제 매출이' → 실제 날짜(prevHeader) 표시로 수정
<!-- session-close:2026-03-01:미컨펌-알림-날짜-버그-수정 -->

### ⚙️ 예약 오류 체크 - 픽코 CDP 타임아웃 원인 분석
- 픽코 예약 실패 원인 확인 (Runtime.callFunctionOn timed out)
- 픽코 서버 일시 지연 → 재시도 로직 정상 작동 확인
- 3건 모두 최종 픽코 등록 성공 확인 (verified)
<!-- session-close:2026-03-01:예약-오류-체크-픽코-cdp-타임아웃-원인-분석 -->

### ⚙️ 스카 재시작 및 부팅 확인
- 스카 재시작 (PID 66467)
- 부팅 완료 확인 (5.2초, isError=false)
<!-- session-close:2026-03-01:스카-재시작-및-부팅-확인 -->

### ✨ 투자팀봇 Phase1 구현 및 검증
- bots/invest 전체 구현 (20파일)
- DuckDB 스키마 4테이블
- CCXT 바이낸스/업비트 드라이런
- TA분석가 RSI/MACD/BB
- 신호집계기 Claude API 연동
- 리스크매니저 4규칙
- 실행봇+업비트브릿지
- launchd 2개 등록
- dry-run-test 전체 통과
<!-- session-close:2026-03-01:투자팀봇-phase1-구현-및-검증 -->

### ✨ 투자봇 DEV/OPS 분리 + 3중 체크 시스템
- lib/mode.js DEV/OPS 모드 분리
- lib/health.js 3중 체크 시스템
- start-invest-ops.sh 시작 3중(Shell+Node+API)
- start-invest-bridge.sh 브릿지 3중 체크
- scripts/health-check.js 상태 조회 CLI
- graceful shutdown SIGTERM/SIGINT 핸들러
<!-- session-close:2026-03-01:투자봇-devops-분리-3중-체크-시스템 -->

### ✨ 덱스터 구현 완료 + 일일보고 + 픽스 로그
- 덱스터(Dexter) 클로드팀 점검봇 구현 (8개 체크 모듈)
- 자동수정 (stale lock, chmod 600, 로그로테이션)
- 버그레포트 자동 등록
- --update-checksums 체크섬 베이스라인 갱신
- 일일보고 (--daily-report) + launchd 08:00 KST
- 자동 픽스 이력 기록 (dexter-fixes.json)
- npm install + npm audit fix
- .gitignore *.db 추가
<!-- session-close:2026-03-01:덱스터-구현-완료-일일보고-픽스-로그 -->

### ✨ 아처(Archer) 기술 인텔리전스 봇 구현 완료
- lib/archer/config.js
- lib/archer/store.js
- lib/archer/fetcher.js
- lib/archer/analyzer.js
- lib/archer/reporter.js
- src/archer.js
- launchd ai.claude.archer
- registry.json 아처 등록
- CLAUDE_NOTES.md 아처 섹션 추가
<!-- session-close:2026-03-01:아처archer-기술-인텔리전스-봇-구현-완료 -->

### ✨ KIS 국내주식 실행봇 크리스 구현
- lib/kis.js KIS Open API 클라이언트 신규 (토큰캐시·OHLCV·매수매도·잔고)
- src/kis-executor.js 크리스 봇 신규 (인라인 리스크·드라이런·모의투자)
- lib/db.js Migration v2 exchange 컬럼 추가 + 함수 파라미터 확장
- signal-aggregator.js KIS 파이프라인 + KIS 전용 LLM 프롬프트
- lib/secrets.js isKisPaper/getKisAccount/hasKisApiKey/getKisSymbols 추가
- bots/registry.json 크리스 봇 등록
<!-- session-close:2026-03-01:kis-국내주식-실행봇-크리스-구현 -->

### ✨ 스카팀 루나팀 패턴 적용 ①②③
- DB Migration System (scripts/migrate.js + migrations/)
- Secrets Fallback Strategy (lib/secrets.js + lib/telegram.js)
- Start Script Validation (scripts/preflight.js + start-ops.sh 2중 체크)
<!-- session-close:2026-03-01:스카팀-루나팀-패턴-적용 -->

### ✨ KIS 실전+모의투자 키 이중화 + API 연결 검증
- secrets.json: kis_paper_app_key/secret 분리 저장
- lib/secrets.js: getKisAppKey()/getKisAppSecret() 모드 자동 분기
- lib/kis.js: 토큰 캐시 경로 분리 + VTS TLS 우회 + OHLCV output 키 수정 + 날짜 범위 수정
- 텔레그램 토큰 동기화
- 드라이런 E2E 검증 완료
<!-- session-close:2026-03-01:kis-실전모의투자-키-이중화-api-연결-검증 -->

### ✨ KIS API 연동 완료 및 파이프라인 활성화
- VTS 포트 29443 수정 (기존 9443 오류)
- 잔고 조회 성공 (모의투자 3천만원 확인)
- KIS 파이프라인 signal-aggregator 활성화
- notifyKisSignal·notifyKisTrade 추가 (원화 포맷)
- kis-executor.js notifyKisTrade 교체
<!-- session-close:2026-03-01:kis-api-연동-완료-및-파이프라인-활성화 -->

### 🔧 포캐스트 0원 버그 수정 (공휴일 Prophet 과보정)
- forecast.py yhat≤0 폴백 (yhat_upper*0.5 + confidence=0.15)
- 삼일절·대체공휴일 Prophet 음수 예측 원인 파악
- 3/2 예측 0원→18821원 DB 업데이트
- ETL 정상 확인 (3/1 최종 212800원)
<!-- session-close:2026-03-01:포캐스트-0원-버그-수정-공휴일-prophet-과보정 -->

## 2026-02-28
### ⚙️ pickko-daily-audit 스케줄 22:00 원복
- pickko-daily-audit 23:50→22:00 원복 (plist 수정 + launchd 재등록)
<!-- session-close:2026-02-28:pickkodailyaudit-스케줄-2200-원복 -->

### ⚙️ OpenClaw v2026.2.26 업데이트 및 재시작
- openclaw gateway restart (완전 중지 후 재시작)
- openclaw v2026.2.19-2 → v2026.2.26 업데이트
- 텔레그램 업데이트 완료 알림 전송
<!-- session-close:2026-02-28:openclaw-v2026226-업데이트-및-재시작 -->

### ⚙️ 스카 재부팅
- openclaw gateway restart → 스카 부팅 완료 (durationMs=59s)
<!-- session-close:2026-02-28:스카-재부팅 -->

### 🔧 매출 보고 일반이용 합산 수정
- pickko-daily-summary.js: 23:50 자동 보고 합계에 일반이용(스터디카페) 포함
- pickko-stats-cmd.js: 일별/기간별 조회 합계에 일반이용 포함
- pickko-revenue-confirm.js: 매출 확정 메시지 합계에 일반이용 포함
- CLAUDE_NOTES.md: 매출 보고 시 일반이용 포함 규칙 추가
<!-- session-close:2026-02-28:매출-보고-일반이용-합산-수정 -->

### 🔧 미해결 알림 해제 + 매출 일반이용 합산 수정
- 픽코 취소 실패 알림 수동 resolved 처리 (2026-02-27 18:00 A2)
- naver-monitor 재시작 후 미해결 알림 반복 전송 중단 확인
- pickko-daily-summary.js 일반이용 합계 포함 수정
- pickko-stats-cmd.js 일반이용 합계 포함 수정
- pickko-revenue-confirm.js 일반이용 합계 포함 수정
- CLAUDE_NOTES.md 매출 보고 규칙 추가
<!-- session-close:2026-02-28:미해결-알림-해제-매출-일반이용-합산-수정 -->

### 🔧 고아 프로세스 자동 정리 추가
- start-ops.sh cleanup_old()에 고아 tail -f 프로세스 자동 정리 추가 (2시간 재시작마다 실행)
<!-- session-close:2026-02-28:고아-프로세스-자동-정리-추가 -->

### 🔧 Runtime.callFunctionOn 타임아웃 근본 수정 + DB 중복 레코드 정리
- pickko-accurate.js page.click→evaluate (회원선택 버튼)
- pickko-verify.js page.click→evaluate (검색 버튼)
- start-ops.sh PICKKO_PROTOCOL_TIMEOUT_MS=300000 추가
- DB 중복 레코드 정리 (010-2187-5073 03-14 failed)
<!-- session-close:2026-02-28:runtimecallfunctionon-타임아웃-근본- -->

### 🔧 23:50 generalRevenue 미수집 + 중복예약 표시 버그 수정
- isMidnight 버그 수정 (hourKST===0 → hourKST===23
- 0) — 23:50 실행시 generalRevenue 수집
- dedup 키 수정 (date
- start
- end
- room → date
- start
- room) — 중복예약 11건→8건 정리
- launchd runs=0 원인 규명 — 재부팅 카운터 리셋, 오딧 정상 운영 확인
- etl.py sqlite_con.close() finally 블록 이동
<!-- session-close:2026-02-28:2350-generalrevenue-미수집-중복예약-표 -->

### 🔧 CL-006 코딩가이드 리팩토링 완료 확인 + 백필 스크립트
- CL-006 플랜 전항목 완료 확인 (P0~P4 모두 이전 세션에서 구현됨)
- backfill-study-room.js 36건 업데이트 완료 (이전 세션 작업)
- pickko-daily-summary isMidnight 23:50 버그 수정 확인
<!-- session-close:2026-02-28:cl006-코딩가이드-리팩토링-완료-확인-백필-스크립트 -->

## 2026-02-27

### 인프라 & 문서
- **시스템 설계 v2.0** — SYSTEM_DESIGN.md 전면 개정 (봇별 LLM 확정, 투자팀 3봇, 메모리 할당표)
- **README.md** — 10봇 전체 아키텍처 다이어그램 추가
- **iPad Termius SSH** 설정 완료 (로컬 192.168.45.176 / Tailscale 100.124.124.65)
- **~/.zshrc** alias 등록 (`ska`, `skalog`, `skastatus`)
- OpenClaw 공식 문서 전체 학습 + 투자팀 멀티에이전트 설계
- 2026 LLM·트레이딩봇 커뮤니티 리서치 (`docs/RESEARCH_2026.md`)

### 스카봇 — 기능
- **pickko-ticket.js** `--discount` 플래그: 이용권 전액 할인 (0원 처리), `--reason` 주문 메모
- **findPickkoMember()** → `lib/pickko.js` 공통 함수화 (4개 파일 인라인 코드 통합)
- **완전 백그라운드 모드** — `lib/browser.js` `PICKKO_HEADLESS` 환경변수, `start-ops.sh` `PICKKO_HEADLESS=1`, `ai.ska.naver-monitor.plist` launchd KeepAlive 등록

### 스카봇 — 인프라
- **공유 인프라 구축** — `packages/core` 공유 유틸리티, `packages/playwright-utils`, `bots/_template` 스캐폴딩
- `reservation/lib/cli.js` 추가, 6개 파일 중복 제거

### 스카봇 — 버그 & 안정화
- **BUG-007** 수정 — `protocolTimeout` 30초 + `Promise.race` 8초 타임아웃
- **BOOT 파일명 누출 방지** — `CLAUDE_NOTES.md` BOOT 중 파일명 단독 전송 금지 규칙 추가
- **lib/args.js** 불리언 플래그 지원 (`--key`를 단독 사용 시 true)
- **bug-report.js** 인라인 parseArgs 제거 → `lib/args` 통합

### OpenClaw 최적화
- **BOOT 속도 7분→50초** (8.4× 개선) — `deployer.js` IDENTITY+MEMORY 인라인화, `--sync` 제거, DEV_SUMMARY/HANDOFF BOOT 제외, 7턴→2턴
- **BOOT 54초** 2회 연속 검증 확인 (gemini-2.5-flash)

---

### ♻️ 코딩가이드 목적 재정의 + work-history/coding-guide 세션마감 자동화
- coding-guide.md: 핵심 원칙 섹션 추가, 목적 재정의
- doc-patcher.js: patchWorkHistory + patchCodingGuide 추가
- session-close.js: docsDir 연결
<!-- session-close:2026-02-27:코딩가이드-목적-재정의-workhistorycoding -->

### ♻️ 코딩가이드 Security by Design 전면 적용
- Security by Design 원칙 선언 (어기면 코드가 실행 안 되는 구조)
- lib/secrets.js 강제 검증 패턴 (필수 키 누락 시 즉시 종료)
- pre-commit hook 차단 패턴 (secrets.json git 커밋 자동 차단)
- SafeExchange 클래스 레벨 DEV/OPS 분리 (우회 불가)
- 전체 봇 로그 마스킹·입력 검증·감사 로그 패턴 추가
<!-- session-close:2026-02-27:코딩가이드-security-by-design-전면-적용 -->

### ⚙️ pre-commit 훅 설치 및 공유 인프라 플랜 완료 검증
- scripts/pre-commit 설치 (.git/hooks/ 등록 + chmod +x)
- scripts/setup-hooks.sh 원클릭 설치 스크립트 신규
- packages/core·playwright-utils·_template 플랜 완료 검증 (전 Phase 완료 확인)
<!-- session-close:2026-02-27:precommit-훅-설치-및-공유-인프라-플랜-완료- -->

### ✨ ST-001~003 완료 + ska 설계 + 백로그 전체 등록
- ST-001 state.db 자동 백업 (launchd 03:00 일일)
- ST-002 BUG-006 해결 — deployer.js BOOT 침묵 강화 + telegram.js 파일명 필터
- ST-003 launchd 헬스체크 (10분 주기, 7개 서비스 감시)
- ska 매출예측 시스템 설계 확정 (Prophet + DuckDB, 4개 봇팀)
- 전체 개발 백로그 등록 (ST/FE/MD/LT 20개 항목)
<!-- session-close:2026-02-27:st001003-완료-ska-설계-백로그-전체-등록 -->

### ✨ FE-002 룸별·시간대별 가동률 리포트 구현
- src/occupancy-report.js 신규: 룸별/시간대별 가동률 계산
- 영업시간 09:00~22:00 기준 13슬롯 분석
- --period=week/month --month=YYYY-MM 기간 옵션 지원
- CLAUDE_NOTES.md 가동률 자연어 명령 테이블 추가
<!-- session-close:2026-02-27:fe002-룸별시간대별-가동률-리포트-구현 -->

### ✨ FE-005 로그 rotation (copytruncate, 매일 04:05)
- scripts/log-rotate.js 신규: 10개 로그 copytruncate 방식 로테이션
- ai.ska.log-rotate.plist: 매일 04:05 자동 실행
- 보관 7일, 1KB 미만 스킵, 당일 중복 방지
- health-check.js: 8번째 서비스(log-rotate) 추가
<!-- session-close:2026-02-27:fe005-로그-rotation-copytruncate -->

### ⚙️ FE-006 gemini-2.5-flash execute_tool 누출 버그 재테스트 — 버그 종결
- gemini-2.5-flash telegram run 6건 전수 검사 — execute_tool 텍스트 누출 0건
- 실제 도구 호출(tool=exec) 정상 확인 — 버그 미재현으로 종결
- 부수 발견: sendChatAction 실패 10건 (typing 인디케이터, 메시지 발송 무영향)
<!-- session-close:2026-02-27:fe006-gemini25flash-execute_to -->

### ✨ FE-009 health-check staleness 체크 추가 (naver-monitor 크래시루프 감지)
- health-check.js: checkNaverLogStaleness() 추가 — 15분 무활동 시 알림
- PID 체크만으로 감지 못했던 크래시루프 상황 커버
- 30분 쿨다운 적용, 로그 없으면 스킵
<!-- session-close:2026-02-27:fe009-healthcheck-staleness-체크 -->

### ⚙️ FE-007 mosh 설치 및 아이패드 SSH 환경 개선 검토
- mosh 1.4.0 설치 완료 (brew install mosh)
- ~/.zprofile 생성 — SSH 로그인 셸 PATH 설정 (mosh-server 검색 가능)
- 검토 결과: 한글 입력 개선 없음(transport 무관 Ink 버그)
- 실제 이점: WiFi↔LTE 전환 시 세션 유지, 네트워크 복구
<!-- session-close:2026-02-27:fe007-mosh-설치-및-아이패드-ssh-환경-개선 -->

### ⚙️ FE-008 Claude Code 한글 버그 GitHub 이슈 #15705 코멘트 등록
- 기존 이슈 #15705 확인 (OPEN, 9개 코멘트, area:tui bug 레이블)
- 코멘트 추가: macOS 로컬(iTerm2) 재현 + rlwrap/mosh 무효 확인
- 단기 FE 백로그 전체 완료 (FE-002~009)
<!-- session-close:2026-02-27:fe008-claude-code-한글-버그-github -->

### ⚙️ MD-006: data.go.kr API 키 발급 가이드
- secrets.json 플레이스홀더 4개 추가
- improvement-ideas.md MD-006 완료 처리
- API 신청 가이드 작성
<!-- session-close:2026-02-27:md006-datagokr-api-키-발급-가이드 -->

### 🔧 픽코 타임아웃 근본 해결 + 자동 버그리포트 + ska-001 + SKA 통일
- pickko-accurate.js 7단계 page.click→evaluate (Runtime.callFunctionOn 타임아웃 근본 해결)
- pickko-cancel.js 3단계 page.$eval/click→evaluate 동일 수정
- naver-monitor.js autoBugReport() 추가 — 픽코 오류 시 bug-tracker 자동 등록
- ska-001 DuckDB 스키마 생성 (revenue_daily·environment_factors·forecast)
- bots/scar→bots/ska 디렉토리 + 전체 문서 SKA 통일
- MD-006 data.go.kr API 키 4종 secrets.json 등록 완료
<!-- session-close:2026-02-27:픽코-타임아웃-근본-해결-자동-버그리포트-ska001- -->

### ✨ ska-005~008 완료 — 이브크롤링+launchd 스케줄링
- ska-005 이브크롤링(큐넷+수능) — 547건 upsert 343일
- ska-008 launchd 4개 서비스 완료 — etl/eve/eve-crawl/rebecca
- scripts/send-telegram.py + scripts/run-rebecca.sh 생성
- ai.ska.etl(00:30)+ai.ska.eve(06:00)+ai.ska.eve-crawl(일04:30)+ai.ska.rebecca(08:00)
<!-- session-close:2026-02-27:ska005008-완료-이브크롤링launchd-스케줄링 -->

### ✨ ska-006 완료 — Prophet 매출 예측 엔진
- forecast.py Prophet 기본 엔진 (daily/weekly/monthly 3모드)
- regressor: exam_score+rain_prob+vacation_flag+KR 공휴일
- base_forecast=요일히스토리평균 / yhat=Prophet예측 / 신뢰구간 80%
- ai.ska.forecast-daily(매일18:00)+ai.ska.forecast-weekly(금18:00) launchd
- scripts/run-forecast.sh + requirements.txt prophet==1.3.0 추가
<!-- session-close:2026-02-27:ska006-완료-prophet-매출-예측-엔진 -->

### ✨ ska-007 완료 — Prophet regressor exam_events 연동
- forecast.py prophet-v1→v2 업그레이드
- load_history: exam_events JOIN으로 역사데이터 exam_score 강화
- load_future_env: UNION approach로 env+exam_events 완전 커버
- 3월 학력평가 score=5 자동 반영 확인 (3/12 당일, 3/7~11 D-7 prep)
<!-- session-close:2026-02-27:ska007-완료-prophet-regressor-ex -->

### ✨ ska-014/015: 대학교 크롤링 + 공무원 정적 캘린더
- ska-014: 가천대·단국대 죽전 시험기간 Playwright 크롤링
- ska-015: 공무원 시험 정적 캘린더 (국가직9급·지방직9급·7급·경찰·소방)
- upsert_events source 파라미터 추가 (calc/crawl/static 구분)
- exam_events: 850행 (calc547+crawl148+static155)
- 4월 중간고사 exam_score 피크 12~15 정상
<!-- session-close:2026-02-27:ska014015-대학교-크롤링-공무원-정적-캘린더 -->

### ⚙️ 설계문서 v2.1: 레베카 LLM 제거 확정
- ska-design.md v2.1 업데이트
- 레베카 LLM 완전 제거 (팀 테이블·LLM 레이어·리포트 종류·피드백 루프)
- LLM은 포캐스트 월간 전담으로 확정
- launchd 스케줄 전체 17개 plist 현황 반영
- Phase 1·2 완료 표기
<!-- session-close:2026-02-27:설계문서-v21-레베카-llm-제거-확정 -->

### ⚙️ 설계문서 v2.2: Phase 3/3+ 루프 자동화 로드맵
- Phase 3 목표 명확화 (진단→수동 적용, 반자동, 3개월+)
- Phase 3+ 신설 (완전 자동 루프, 6개월+, 백테스트+롤백)
- 루프 구조 요약 섹션 추가 (Phase별 자동화 수준)
- ska-design.md v2.2 업데이트
<!-- session-close:2026-02-27:설계문서-v22-phase-33-루프-자동화-로드맵 -->

### ⚙️ tmux Remote Control 설정 + LLM API 코드 개선
- tmux 설치 + ai.ska.tmux launchd 등록 (재부팅 자동 복구)
- 아이패드 Claude Remote Control (/rc) 연결 확인
- forecast.py _call_llm_diagnosis system 파라미터 분리 + Prompt Caching + temperature=0.1 + 에러 세분화
- coding-guide.md 섹션 12/13 Anthropic SDK 직접 호출 패턴 + temperature 가이드 + 모델 표 추가
<!-- session-close:2026-02-27:tmux-remote-control-설정-llm-api -->

### ♻️ CL-006 코딩가이드 기준 전체 코드 리팩토링
- maskPhone/maskName 함수 추가 (lib/formatting.js)
- JS 8개 파일 개인정보 로그 마스킹 (phone/name)
- Python DB 연결 try/finally 래핑 (etl/rebecca/eve)
- Python 에러 묵음→경고 출력 (etl/eve/eve_crawl)
- writeFileSync→saveJson 전환 (naver-monitor/bug-report)
- inspect-naver.js 하드코딩 경로 제거
<!-- session-close:2026-02-27:cl006-코딩가이드-기준-전체-코드-리팩토링 -->

### ⚙️ pickko-daily-audit/summary 실행 시간 23:50으로 변경
- pickko-daily-audit 22:00→23:50 (plist 수정 + launchd 재등록)
- pickko-daily-summary 00:00→23:50 (LaunchAgents plist 수정 + launchd 재등록)
<!-- session-close:2026-02-27:pickkodailyauditsummary-실행-시간- -->

## 2026-02-26

### 스카봇 — 신규 기능
- **pickko-ticket.js** — 픽코 이용권 추가 CLI (9단계 자동화, 기간권 중복 방지)
- **pickko-daily-summary.js** — 09:00 예약현황 / 00:00 마감 매출+컨펌 (launchd)
- **lib/pickko-stats.js** — fetchMonthlyRevenue/fetchDailyRevenue/fetchDailyDetail
- **매출 분리** — `daily_summary` 테이블에 pickko_total/pickko_study_room/general_revenue 추가, 일반이용 매출 별도 표시
- **pickko-revenue-confirm.js** — 미컨펌 daily_summary → room_revenue 누적 + 텔레그램
- **pickko-stats-cmd.js** — 날짜/주/월/누적 매출 자연어 조회 CLI
- **pickko-query.js** — 예약 조회 (날짜/이름/전화/룸 필터) CLI
- **pickko-cancel-cmd.js** — 자연어 취소 명령 래퍼 (stdout JSON)
- **자연어 E2E 테스트** — `test-nlp-e2e.js` 27케이스 100% 통과

### 스카봇 — 인프라
- **JSON → SQLite 마이그레이션** — `state.db` 단일 파일, AES-256-GCM 암호화, 6개 JSON → 4개 테이블
- **lib/crypto.js** — AES-256-GCM 암호화/복호화, SHA256 kiosk 해시 키
- **lib/telegram.js** — Telegram Bot API 직접 발송 (openclaw 우회), 3회 재시도
- **lib/pickko.js** `fetchPickkoEntries()` 공유 함수 추출 (4개 스크립트가 재활용)
- `fetchPickkoEntries` `sortBy='sd_regdate'` + `receiptDate` 옵션 추가
- **session-close 라이브러리** — `scripts/lib/` 모듈화, `session-close.js` CLI

### 스카봇 — 텔레그램 안정화
- **pending queue** — 3회 재시도 최종 실패 시 `pending-telegrams.jsonl` 저장, 재시작 시 자동 재발송
- **start-ops.sh self-lock** — `SELF_LOCK` 중복 실행 방지 (PID 파일 체크)
- `sendTelegramDirect` async 변환, 3회 재시도 (3초/6초 백오프)

### 스카봇 — 버그 수정
- pickko-accurate.js [5단계] `page.click()` → `page.evaluate()` 교체 (protocolTimeout 해결)
- pickko-accurate.js [1.5단계] `syncMemberNameIfNeeded()` — 픽코↔네이버 이름 자동 동기화
- pickko-cancel.js [6-B단계] — 0원/이용중 예약 취소 폴백 (수정→취소→저장)
- pickko-cancel.js [7-B단계] — 결제대기 예약 취소 폴백
- pickko-kiosk-monitor.js Phase 2B 필터 버그 수정 (naverBlocked 여부 확인 추가)
- pickko-kiosk-monitor.js `verifyBlockInGrid` 재작성 (DOM 좌표 기반 정확한 검증)
- naver-monitor.js 취소 감지 2 조건 개선 (`cancelledHref` null일 때 폴백 방문)

### 스카봇 — 키오스크 자동화 완성
- **pickko-kiosk-monitor.js Phase 2B + 3B** — 키오스크 예약 취소 감지 → 네이버 예약불가 자동 해제
  - `unblockNaverSlot()`: suspended 슬롯 클릭 → fillAvailablePopup → verifyBlockInGrid
  - `clickRoomSuspendedSlot()`, `selectAvailableStatus()`, `fillAvailablePopup()` 신규 함수

### OpenClaw
- **gemini-2.0-flash → gemini-2.5-flash** 모델 교체 (운영 중)
- LLM API 속도 테스트 결과 기록 (groq 1위 203ms, gemini 4위 608ms)

---

## 2026-02-25

### 스카봇 — 신규 기능
- **pickko-daily-audit.js** — 당일 픽코 등록 사후 감사 (22:00+23:50 launchd)
- **pickko-register.js** — 자연어 예약 등록 CLI (stdout JSON)
- **pickko-member.js** — 신규 회원 가입 CLI (stdout JSON)
- **pickko-kiosk-monitor.js** Phase 1~5 전체 완성
  - 키오스크 결제완료 감지 → 네이버 booking calendar 자동 차단
  - `run-kiosk-monitor.sh` + `ai.ska.kiosk-monitor.plist` launchd 30분 주기

### 스카봇 — 안정화 8건
- `lib/files.js saveJson()` 원자적 쓰기 (tmp→rename)
- `pickko-accurate.js` 슬롯 재시도 1회→3회
- `naver-monitor.js rollbackProcessingEntries()` exit 전 롤백
- `start-ops.sh` 로그 1000줄 로테이션
- `naver-monitor.js pruneSeenIds()` 90일 초과 항목 정리
- `ai.ska.pickko-daily-audit.plist` 23:50 실행 추가 (22:00+23:50 2회)

### 스카봇 — 버그 수정
- `pickko-cancel.js` 취소 플로우 완전 재작성 (올바른 환불 플로우: 주문상세→상세보기→환불 버튼)
- `pickko-verify.js needsVerify()` — completed+paid/auto 항목도 재검증 대상 포함
- 테스트 예약불가 4건 복원 + 루트 임시 파일 11개 삭제 정리

---

## 2026-02-24

### 스카봇 — 신규 기능
- **픽코 자동 취소** — `pickko-cancel.js` 신규, naver-monitor.js 취소 감지 추가
- **OPS 취소 활성화** (`PICKKO_CANCEL_ENABLE=1`)
- **Heartbeat** 추가 (1시간 주기, 09:00~22:00 텔레그램)
- **log-report.sh** 신규 + launchd `ai.ska.log-report` 3시간 주기
- **pickko-verify.js** — pending/failed 예약 재검증 스크립트
- **pickko-verify.js 자동 스케줄링** — `run-verify.sh` + launchd 08:00/14:00/20:00

### 스카봇 — 인프라
- **lib/ 공유 라이브러리 리팩토링** — 7개 신규 모듈 (utils/secrets/formatting/files/args/browser/pickko)
- 4개 src 파일 중복 코드 220줄 제거
- **CLAUDE_NOTES.md** 시스템 구축 (클로드→스카 전용 채널 파일)
- **SYSTEM_STATUS.md** 자동 생성 (`deploy-context.js updateSystemStatus()`)

### 스카봇 — 로직 개선
- 취소 감지 → `previousConfirmedList` 리스트 비교 방식 (카운터 비교 폐기)
- 보안인증 대기 30분 + 텔레그램 알림 (원격 인증 지원)
- 모니터링 주기 3분 (`NAVER_INTERVAL_MS=180000`)
- `validation.js` 24:00 지원
- 야간 알림 차단 + `flushPendingAlerts` 09:00 일괄 발송

### OpenClaw
- gemini-2.0-flash → gemini-2.5-flash 교체 (첫 번째 시도, deprecated 대응)

---

## 2026-02-23

### 인프라
- **RAG 시스템** 구축 (`~/projects/rag-system`, FastAPI + ChromaDB, 포트 8100, Python 3.12)
- naver-monitor.js RAG 연동 (예약 이력 자동 저장)
- OpenClaw Gemini 모델 전환 (텔레그램 응답 정상화)

### 스카봇 — 인프라
- **BOOT.md** 자동 기억 복원 시스템 구축
- **컨텍스트 관리 시스템** — `registry.json` + `deploy-context.js`
- **nightly-sync.sh** + launchd 자정 자동 보존 시스템
- 모델 변경 자동 컨텍스트 보존 (BOOT 1단계 sync 자동 실행)
- `start-ops.sh` 자동 재시작 루프 + `cleanup_old()` 구 프로세스 정리
- naver-monitor.js 락 로직 개선 (SIGTERM→SIGKILL)

### 스카봇 — 버그 수정
- `process.exit(0)` 버그 수정 (픽코 성공이 exit code 1로 오인되던 문제)
- DEV/OPS 데이터 파일 분리 (`naver-seen-dev.json` / `naver-seen.json`)
- detached Frame 버그 수정 (`runPickko()` 내 `naveraPage.close()` 제거)

---

## 2026-02-22

### 스카봇 — 최초 완성
- `naver-monitor.js` 재작성 (네이버 파싱 10건 성공)
- `pickko-accurate.js` Stage [6] 4-Tier Fallback 완성
- DEV 모드 전체 테스트 — Stage [1-9] 완전 성공
- OPS/DEV 로직 분리 + 알람 시스템
- **22:00 — OPS 모드 전환** (사장님 협의, 실운영 시작) ✅

---

## 통계 요약

| 기간 | 주요 마일스톤 |
|------|------------|
| 2026-02-22 | OPS 모드 전환 (실운영 시작) |
| 2026-02-23 | RAG 시스템 + 컨텍스트 관리 기반 구축 |
| 2026-02-24 | 자동 취소 + 공유 라이브러리 리팩토링 |
| 2026-02-25 | 키오스크 모니터 + 안정화 8건 |
| 2026-02-26 | SQLite 마이그레이션 + 매출 분리 + NLP E2E 100% |
| 2026-02-27 | 공유 인프라 + 백그라운드 전환 + BOOT 8.4× 개선 |
| 2026-02-28 | ETL 버그 수정 + OpenClaw 업데이트 + ska DB 백필 |
| 2026-03-01 | 루나팀 Phase 0 드라이런 + 덱스터 + 아처 + KIS 크리스 구현 |
| 2026-03-03 | 스카팀 고도화 v3.0 + 루나팀 크립토 OPS 전환 + 실행체인 버그 수정 + ETH→USDT |
| 2026-03-04 | RC 세션 폭발 버그 수정 + tmux/RC 전체 제거 + 루나팀 Phase 3 고도화 + DuckDB WAL 버그 수정 + 암호화폐 OPS 전환 |

---

## 2026-03-17

### 팀별 운영 변수 외부화 정리
- `investment`
  - `runtime_config` 기반으로 루나/네메시스/time-mode 운영 임계치 외부화
  - 암호화폐와 국내외장 실행 모드는 분리 유지, 공용 헬퍼에서 통합 관리
- `reservation`
  - 브라우저 launch 재시도, timeout, stale 판정, monitor 재시도 한도 외부화
- `ska`
  - forecast / rebecca / 리뷰 스크립트 운영 기준 외부화
  - Python/Node가 같은 설정 파일을 읽도록 정리
- `worker`
  - worker lead / n8n intake / health timeout 외부화
  - web client auth timeout / reconnect delay 외부화
- `orchestrator`
  - critical path URL, timeout, payload warning 기준 외부화
- `claude`
  - dexter-quickcheck / n8n / pattern 체크 임계치 외부화
- `blog`
  - health/n8n timeout + generation length/retry/continue token 기준 외부화

### 운영 문서/도구 정리
- `docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md` 작성
- `scripts/show-runtime-configs.js` 추가
- 운영자가 코드 대신 설정 파일을 먼저 확인하도록 팀별 관리 포인트 문서화

### 루나팀 운영 보정
- 국내/해외장을 모의투자 기준으로 다시 정렬
- 국내/해외 주문 금액 clamp 기준 보정
- 자동매매 일지/주간 리뷰를 `암호화폐 / 국내장 / 해외장` 섹션으로 분리
- 로그의 `[PAPER]` / `KIS PAPER=true` 표현을 실제 실행 상태와 맞춤

### 덱스터 false positive 완화
- 고아 Node 프로세스 오탐 축소
- Swap 경고 기준 완화
- `forecast_results` 누락을 경고에서 분리

### 추가 개발 메모
- `runtime_config` 후보값을 일일/주간 분석해서 변경 제안하는 자동화 필요
- 제이 전용 LLM 리뷰는 유지하고, 전체 LLM 리뷰는 운영 분석 리포트와 중복 축소 가능
- 다음 운영 단계는 “추가 외부화”보다 “실제 운영 중 바꾸는 값 수집”이 더 중요

---

## 2026-03-04

### 긴급 — claude remote-control 세션 폭발 사고 (2,407건)
- `ai.agent.cc-remote` launchd → `cc-remote-start.sh` (while true 루프) 실행 중
- `claude remote-control` 내부 버그: `--sdk-url <session_id>` 노드 플래그 전달 → 즉시 실패 → 10초 후 재시작 루프
- 발견 당시 2,407개 세션 생성됨
- 대응: PID 65530 종료 → launchd unload → plist + script 삭제

### tmux / Termius / Remote Control 전체 제거
- 삭제 항목: `ai.agent.cc-remote.plist`, `ai.agent.tmux.plist`, `ai.ska.tmux.plist`
- 삭제 스크립트: `cc-remote-start.sh`, `update-rc-context.sh`, `tmux-start.sh`, `~/start-ska-session.sh`
- 삭제 파일: `RC_CONTEXT.md`, `config/tmux-windows.json`
- `CLAUDE.md` Remote Control 섹션 제거, `~/.zshrc` alias 제거
- `bots/claude/lib/checks/bots.js` `ai.ska.tmux` 체크 제거

### 루나팀 Phase 3 고도화 v2 (TASK 4~9)
- **TASK 4**: `launchd/ai.investment.argos.plist` 생성 (6시간 주기, 아르고스 전략 수집)
- **TASK 5**: `team/aria.js` — `isMarketOpen(exchange)` export + KIS/KIS Overseas 장중 가드
- **TASK 8**: `shared/cost-tracker.js` — `reportToTelegram()` 메서드 클래스 내부 이동 (class 외부 선언 버그 수정)
- **TASK 9**: `team/chronos.js` — CJS → ESM 전환 + `chronosGuard()` 추가

### DuckDB WAL 재생 버그 수정
- 증상: `[Error: Connection was never established]` — DB 오픈 시마다 실패
- 원인: `ALTER TABLE signals ADD COLUMN` WAL 진입을 DuckDB 1.4.4가 재생 불가
  - 버그 메시지: `Calling DatabaseManager::GetDefaultDatabase with no default database set`
- 해결: `shared/db.js` `initSchema()` 끝에 `CHECKPOINT` 추가 → WAL을 메인 DB로 즉시 플러시
- 검증: 단독 initSchema + 연속 2회 오픈 모두 성공

### E2E 전체 테스트 통과
- crypto: 6.8초 ✅ | domestic: 5.7초 ✅ (장 마감, 아리아 스킵 정상) | overseas: 9.2초 ✅

### 암호화폐 OPS 전환 (LIVE 실거래 테스트)
- `PAPER_MODE=false node markets/crypto.js --force` 실행
- 결과: BTC/USDT BUY 68% → 네메시스 $100 승인 → 헤파이스토스 실행 시도 → 잔고 부족 ($14.02)
- 파이프라인 완전 정상 동작 확인 (Haiku LLM 사용 확인)

### LLM 정책 v2.2 — Groq 전용
- 사용자 지시: "llm은 groq 유지한다"
- `shared/llm-client.js` 변경: `HAIKU_AGENTS` 제거, 전 모드 Groq Scout 전용
- 결과: LIVE 모드도 Groq (무료, $0/월)

### 투자 리포트 시스템 (team/reporter.js)
- 바이낸스 실잔고 + 모의 포지션 미실현 PnL + 신호 통계 + LLM 비용
- `npm run report` / `npm run report:tg`
- 첫 리포트 텔레그램 발송 완료

### 커밋 내역
- `0395e8d` Phase 3 고도화 (TASK4-9): argos plist, aria 시장가드, chronos ESM, cost-tracker
- `fa273f6` DuckDB WAL 수정 + cost-tracker reportToTelegram 클래스 내부 이동
- `915859c` LLM 정책 v2.2 — Groq 전용
- `d603831` 투자 리포트 시스템 (reporter.js)

## 2026-03-05 (세션 다수)

### 출금지연제 자동예약 + 덱스터 Phase C
deps.js cd→cwd 수정(launchd PATH 오류) | git 상태 패턴 저장 제외(false positive) | getNewErrors 중복 수정(GROUP BY) | node→process.execPath 수정 | 업비트 출금지연제 자동예약(luna-commander) | 신규감지 창 24h→8h | --clear-patterns CLI | RAG 서버 optional 처리

### 헬스체크 회복 로직 + 제이 할루시네이션 방지
health-check.js 회복 감지·알림·state 저장 | backup-db.js async 누락 수정 | TOOLS.md bot_commands 명령 테이블 + 할루시네이션 방지 경고

### 세션 마감 정리 + 모바일 알림 최적화
- 공용 `reporting-hub` notice/report 렌더러를 모바일 친화형으로 축약하고 `payload.details` 우선 렌더링으로 긴 본문 중복을 줄임
- `telegram-sender`에서 긴 구분선과 연속 공백을 발송 직전 정규화하도록 보강
- 루나 실시간 알림/주간 리뷰 메시지의 구분선과 장문 근거를 축약
- 투자 실험값 `runtime_config.luna.fastPathThresholds.minCryptoConfidence = 0.44` 실제 운영 `config.yaml` 반영
- suggestion log `498d9f9c-4725-460a-a5ea-129e82f3be19` 상태를 `applied`로 올리고 검증 리포트 기준 `observe` 판단 확인
- 세션 종료 문서(SESSION_HANDOFF / RESEARCH_JOURNAL / TEST_RESULTS / CHANGELOG) 갱신
- 덱스터 체크섬 베이스라인 갱신 완료 (`bots/claude/.checksums.json`, 65개 파일)

### 자동화 리포트 해석력 보강
- `jay-llm-daily-review.js`에 `dbSourceStatus`를 추가해 `EPERM` 기반 실패를 `sandbox_restricted`로 분류하고, 현재 실행 컨텍스트 제한 가능성을 리포트에서 직접 읽을 수 있게 정리
- `jay-llm-daily-review.js`가 `tmp/jay-llm-daily-review-db-snapshot.json`에 최근 DB 집계를 저장하고, 이후 DB 접근이 막혀도 snapshot fallback으로 리뷰를 유지하도록 보강
- `packages/core/lib/health-runner.js`를 보강해 team health script가 빈 `예외:` 대신 `[EPERM] at ...` 같은 실제 실패 힌트를 stderr에 남기도록 정리
- `ska-sales-forecast-daily-review.js`에 `requestedDays / effectiveDays`를 추가해 주간 리뷰와 같은 기간 해석 규칙을 적용
- `daily-ops-report.js`에 `localFallback` 메타를 추가해 investment / reservation 팀이 `health_report_failed_local_fallback + local fallback 활동 신호 1건`으로 읽히도록 정리
- `daily-ops-report.js` 추천 문구를 `db_sandbox_restricted`와 `local fallback 활동 신호`를 구분하는 방식으로 보강해, “DB 제한은 있지만 팀 활동은 있음”을 운영자가 바로 해석할 수 있게 정리

### 전략 백로그 재정렬 + 루나 공격적 매매 실구현
- `PLATFORM_IMPLEMENTATION_TRACKER`에서 이미 완료된 `워커웹 로컬/외부 IP 접속`을 PENDING 최우선 과제에서 제거
- 루나 주식 전략을 단순 문구가 아니라 `runtime_config` 기반 `stockStrategyMode / stockStrategyProfiles`로 승격
- 네메시스가 `stockRejectConfidence`, `stockAutoApproveDomestic`, `stockAutoApproveOverseas`를 실제 하드 규칙으로 사용하도록 연결
- 소규모 주식 BUY는 공격적 모드에서 자동 승인되고, 매우 낮은 확신도는 조기 REJECT되도록 불변식 회복

### 아처 폴백 순서 변경
- 아처 LLM 분석 체인을 `gpt-4o-mini` 단일 호출에서 `Anthropic Sonnet → OpenAI gpt-4o-mini → Groq Scout` 순서로 재구성
- `lib/archer/config.js`의 `LLM_CHAIN`으로 외부화해 이후 우선순위 변경을 설정 레이어에서 처리 가능하게 정리
- 문서상 “아처는 Claude Sonnet 급 분석 품질 우선”이라는 기존 가이드와 실제 코드 경로를 다시 일치시킴

### 공용 LLM 모델 셀렉터 1차 통합
- `packages/core/lib/llm-model-selector.js` 추가
- 제이, 아처, 클로드 리드, 워커 AI, 블로그 writer/social/curriculum, 공용 chunked-llm, 투자 agent 라우팅의 모델/폴백 기준을 selector key로 통합
- 팀별 고유 정책은 유지하되, 체인 상수와 기본 모델 우선순위는 공용 selector에서 조회하도록 정리
- 이후 운영상 모델 변경 시 개별 파일 하드코딩보다 selector 레이어 우선 수정이 가능해짐

### 공용 LLM 모델 셀렉터 2차 통합
- 오케스트레이터 `runtime_config.llmSelectorOverrides`를 추가해 제이 intent/chat fallback 체인을 selector override로 운영 제어 가능하게 정리
- 투자 `runtime_config.llmPolicies.investmentAgentPolicy`를 추가해 agent별 route와 주요 모델 상수를 selector override로 관리 가능하게 정리
- 공용 selector는 기본 체인을 보유하고, 팀 runtime_config는 override만 담당하는 구조로 역할 경계를 분명히 함

### 공용 LLM 모델 셀렉터 3차 통합
- 워커 `runtime_config.llmSelectorOverrides`를 추가해 `worker.ai.fallback`, `worker.chat.task_intake`를 운영 설정 기반으로 제어 가능하게 정리
- 워커 모니터링 DB의 `preferredApi`는 provider 선택만 담당하고, 각 provider의 실제 모델명은 selector override가 결정하는 구조로 경계 정리
- 공용 selector를 중심으로 `기본 체인 + runtime_config override + 운영 선호값(DB)`가 계층적으로 결합되도록 구조를 맞춤

### 공용 LLM 모델 셀렉터 4차 통합
- 블로그 `runtime_config.llmSelectorOverrides`를 추가해 `blog.pos.writer`, `blog.gems.writer`, `blog.social.*`, `blog.star.*`, `blog.curriculum.*` 경로를 운영 설정으로 제어 가능하게 정리
- 블로그 생성 계열은 writer/social/curriculum/stage별로 selector key를 유지하고, 실제 모델 체인은 config override로만 바꾸는 구조로 경계 정리
- 이후 블로그 발행 실험이나 품질 튜닝 시 개별 파일 하드코딩 수정 없이 `config.json` 우선 조정이 가능해짐

### 공용 LLM 모델 셀렉터 5차 통합
- 클로드 `runtime_config.llmSelectorOverrides`를 추가해 `claude.archer.tech_analysis`, `claude.lead.system_issue_triage`, `claude.dexter.ai_analyst` 경로를 운영 설정으로 제어 가능하게 정리
- 아처/클로드 리드는 chain override, 덱스터는 alert level별 low/high 모델 override를 받는 구조로 역할을 분리
- 이로써 주요 텍스트 생성 경로의 공용 selector + 팀별 runtime override 패턴이 제이/투자/워커/블로그/클로드까지 거의 닫힘

### 공용 LLM 모델 셀렉터 fallback 표준화
- `describeLLMSelector()`를 추가해 selector 결과를 `primary + fallbacks + chain` 형식으로 표준화
- 투자처럼 route 기반 경로도 `fallbackChain`을 명시적으로 반환해 운영 관점에서 실제 폴백 순서를 볼 수 있게 정리
- `scripts/llm-selector-report.js`를 추가해 현재 시스템 전체 LLM selector 상태를 텍스트/JSON으로 한 번에 조회 가능하게 만듦
- `packages/core/lib/llm-selector-advisor.js`를 추가해 speed-test 기준 selector 추천(`hold / compare / switch_candidate / observe`)을 생성
- `scripts/llm-selector-override-suggestions.js --write`로 selector override 추천 스냅샷을 워커 DB에 저장할 수 있게 정리
- `scripts/review-llm-selector-override-suggestion.js`를 추가해 저장된 selector override 추천의 승인/보류/반려/적용 상태를 관리할 수 있게 정리
- `scripts/apply-llm-selector-override-suggestion.js`를 추가해 승인된 selector override 추천을 실제 `config.json` 경로에 반영하고 applied 상태까지 연결할 수 있게 정리
- `scripts/speed-test.js`가 최신 스냅샷과 별도로 `llm-speed-test-history.jsonl` 히스토리를 누적하도록 보강
- `scripts/reviews/llm-selector-speed-review.js`를 추가해 최근 speed-test 히스토리의 top model, current/recommended, recommendation을 요약할 수 있게 정리
- `scripts/reviews/llm-selector-speed-daily.js`를 추가해 speed-test 실행과 speed review를 일일 러너로 묶을 수 있게 정리
- 블로그 `publ.js`에 내부 링킹 Phase 2 후처리를 추가해 발행 시점에 과거 `published + naver_url` 포스트를 조회하고 제목 플레이스홀더를 실제 링크로 치환할 수 있게 정리
- `packages/core/lib/naver-blog-url.js`와 `scripts/parse-naver-blog-url.js`를 추가해 네이버 블로그 URL 파싱/정규화 유틸과 CLI를 마련
- `bots/blog/scripts/mark-published-url.js`를 추가해 수동 발행 직후 `postId/scheduleId + naverUrl`을 검증하고 `blog.posts.naver_url`에 canonical URL로 기록할 수 있게 정리
- 워커웹 모니터링 하위에 `/admin/monitoring/blog-links` 페이지를 추가해 최근 블로그 글을 보면서 네이버 발행 URL을 직접 입력하고 저장할 수 있게 정리
- 워커 서버에 `/api/admin/monitoring/blog-published-urls` GET/POST를 추가해 블로그 URL 입력 화면에서 recent post 조회와 canonical URL 저장을 바로 처리할 수 있게 정리

### 알림 메시지 모바일 최적화
- reporting-hub notice/report 렌더러를 모바일 친화형으로 축약
- payload.details 우선 사용으로 긴 원문 중복 노출 제거
- telegram-sender에서 긴 구분선/연속 공백 정규화
- 루나 실시간 알림과 주간 리뷰 메시지의 구분선/근거 길이 축약

### 자동화 리포트 health source 표준화
- `daily-ops-report.js`에 `sourceMode`를 추가해 팀 health source를 `unavailable / local_fallback / auxiliary_review` 기준으로 표준화
- `investment / reservation`은 `db_sandbox_restricted`이지만 `local fallback 활동 신호`가 살아 있는 팀으로 분리해 읽을 수 있게 정리
- `orchestrator / worker / claude / blog`는 현재 `sourceMode=unavailable`로 표시돼, 실제 health 관측 공백이 더 큰 축이라는 점을 운영 리포트에서 바로 읽을 수 있게 정리

## 2026-03-20

### 비디오팀 신규 과제 문서 정리
- `bots/video/docs/`에 비디오팀 인수인계/설계 문서 묶음을 정리해 신규 구축 과제의 기준 문서를 리포지토리 안으로 고정했다.
- 누락돼 있던 `video-team-tasks.md`를 추가해 `VIDEO_HANDOFF.md`, `video-automation-tech-plan.md`, `video-team-design.md`와 참조 관계가 끊기지 않도록 보완했다.
- `video-automation-tech-plan.md`의 프로젝트 경로를 현재 저장소 기준(`ai-agent-system/bots/video/`)으로 정리해 외부 경로와 리포지토리 경계를 명확히 했다.
- `docs/SESSION_HANDOFF.md`의 비디오팀 섹션을 갱신해, 현재 상태를 `문서 정리 완료 / 구현 스캐폴딩 시작 전`으로 맞추고 다음 자연스러운 단계가 과제 1 최소 스캐폴딩이라는 점을 명시했다.
- `bots/video/scripts/`는 문서 배치용 보조 폴더였고 실제 운영/구현 스크립트가 아니므로 제거해 신규 폴더의 역할 경계를 단순화했다.

## 2026-03-19

### 루나 퍼널 계측 강화 + 바이낸스 전환 보수성 완화
- `pipeline-decision-runner.js`가 `pipeline_runs.meta`에 `buy_decisions / sell_decisions / hold_decisions`를 함께 저장하도록 확장
- `trading-journal.js`, `weekly-trade-review.js`에 시장별 `decision / BUY / SELL / HOLD / executed / weak / risk / saved` 퍼널 병목 섹션 추가
- 현재 관측 결과는 `weak/risk`보다 `portfolio decision` 쪽 병목 가능성이 크다는 점을 더 직접적으로 보여주기 시작
- `config.yaml`에서 `screening.crypto.max_dynamic=12`, `min_volume_usdt=750000`, `minConfidence.live.binance=0.44`, `debateThresholds.crypto=0.56/0.18`, `fastPath minCryptoConfidence=0.40` 반영
- `luna.js` crypto 프롬프트에 분산 진입, HOLD 남발 억제, 재진입 가능한 추세 종목 선호를 명시
- 바이낸스는 최종 signal 저장 단계에서 `timeMode.minSignalScore`가 runtime crypto 기준보다 더 보수적일 때 runtime 기준을 우선 적용하도록 정리

### 루나 시스템 재점검 Phase 준비
- `docs/LUNA_RESET_AUDIT_PLAN_2026-03-19.md` 작성
- `docs/LUNA_RESET_AUDIT_CODEX_PROMPT_2026-03-19.md` 작성
- 부분 보완이 충분한지, 재설계가 필요한지 판단하기 위한 진단 범위, 핵심 질문, 산출물, 구현 경계를 문서로 고정
- global `error-review`는 `sourceMode=auxiliary_review`로 표시해 보조 운영 신호와 팀 health source를 같은 축으로 혼동하지 않게 정리

### 스카팀 취소 루틴 버그 수정
page.click(body)→Escape 키 수정(상세보기 블러 문제) | toCancelKey bookingId 기반 개선(슬롯 재예약 키 충돌 방지)

### 루나팀 국내/국외 모의투자 배포
국내장 모의투자 활성화(ai.investment.domestic) | 포트폴리오 프롬프트 심볼 환각 버그 수정(luna.js) | 덱스터 신호 exchange 불일치 감지 추가

### LLM 토큰 이력 DB 기록 + 거래 일지
llm-client.js Groq/OpenAI 토큰·응답시간 DB 기록 | token_usage 테이블 duration_ms 컬럼 | scripts/trading-journal.js 신규

### OpenClaw 업데이트 + 제이 RAG 연동
OpenClaw 2026.2.26→2026.3.2 | TOOLS.md RAG 검색 섹션(system_docs 12건 임베딩) | state.db e2e 테스트 데이터 삭제

### 덱스터 AI 분석 레이어 + 2-티어 퀵체크
- bots/claude/lib/ai-analyst.js: OpenAI gpt-4o-mini/4o 종합 진단, dexter-insights.json (최대 20개 FIFO)
- bots/claude/src/dexter-quickcheck.js: 5분 주기 크래시 감지·자동재시작·중복알림방지
- ai.claude.dexter.quick launchd 등록 (StartInterval=300, --telegram --fix)
- 덱스터 체크 티어: quick(5분) + full(1h)

### 클로드팀 개선 5가지
bot-behavior.js 신규(독터루프+실패율+루나급속신호) | doctor.js RAG 복구 실패 저장+getPastSuccessfulFix | claude-lead-brain.js Shadow 4단계(CLAUDE_LEAD_MODE) | health-dashboard-server.js 포트3032 | deps.js 패치티켓 RAG 자동저장

### 시스템 인프라 개선 3가지
scripts/weekly-team-report.js 4팀 KPI 주간리포트 | pg-pool getAllPoolStats/checkPoolHealth/getClient 추가 | 카오스테스트 3종(db-pool-exhaust/llm-failover/telegram-rate-limit)

### 블로그팀 Phase 1 MVP (2026-03-09)
blo.js(팀장) + richer.js(IT뉴스/HN/날씨) + pos-writer.js(강의8000자+) + gems-writer.js(일반7000자+) + publ.js(마크다운저장) | 지원모듈: category-rotation/quality-checker/daily-config | blog 스키마 5테이블 마이그레이션 완료 | 120강 커리큘럼 시딩 완료 | ai.blog.daily launchd 등록(06:00 KST)

### 블로그팀 팀 제이 핵심 기술 통합 + 구글드라이브 저장 (2026-03-09)
RAG/MessageEnvelope/trace/StateBus/tool-logger/llm-cache/mode-guard 통합 | quality-checker AI탐지리스크(0~100) | GEO/AEO + ai-agent-system 컨텍스트 시스템프롬프트 통합 | RAG 실전에피소드+내부링킹 자동화 | 리라이팅가이드 텔레그램 포함 | publ.js 구글드라이브 자동저장(/010_BlogPost) | 글자수 기준 실측조정(강의7000/일반3500) | 전파이프라인 통과(강의8018자, 일반3990자) | rag_blog 컬렉션 pgvector 추가 | 커밋: a12364e, e361917, dae45f6

### 워커 매출 / 스카 매출 일치화 + 리스트 페이지네이션 보강
- `reservation.daily_summary`를 `test-company`의 매출 원천으로 사용하는 `bots/worker/lib/ska-sales-sync.js` 신규
- `worker.sales`에 스카 일반석/스터디룸 투영 구조를 자동 동기화하고 중복 스카 매출 행은 soft-delete 정리
- 스카 누락 구간을 재파싱해 `2026-03-16`, `2026-03-17`, `2026-03-18` 원천 데이터를 복구
- 워커 매출관리의 `누적 금액`/`월간 매출` 집계 의미를 각각 전체 누적 / 이번 달 기준으로 바로잡음
- 매출 목록 조회 상한을 늘려 `2026-01-13` 이전 데이터가 UI에서 잘리지 않도록 보강
- 공용 `DataTable` 페이지네이션 숫자를 최대 5개씩 노출하도록 정리

### 스카 스터디룸 매출 원천 보정 + 0 덮어쓰기 방지
- `reservation.daily_summary`에서 `pickko_study_room=0`인데 `room_amounts_json`에는 스터디룸 금액이 있는 날짜 37건을 확인
- `bots/worker/lib/ska-sales-sync.js`가 `pickko_study_room -> room_amounts_json -> (pickko_total-general_revenue)` 우선순위로 스터디룸 매출을 계산하도록 보강
- `bots/reservation/lib/db.js`의 `upsertDailySummary()`를 `COALESCE(EXCLUDED, daily_summary)` 기반으로 바꿔, 자정 외 보고가 `pickko_*` 값을 0으로 덮지 않도록 수정
- `bots/reservation/auto/scheduled/pickko-daily-summary.js`에서 자정이 아닐 때 `pickkoTotal/pickkoStudyRoom/generalRevenue`를 `null`로 넘겨 기존 수집값을 유지하도록 정리
- 원천 `daily_summary` 37건을 `room_amounts_json` 합계 기준으로 복구한 뒤 `test-company` 워커 매출 미러도 재동기화해 mismatch 0건을 확인
- `bots/reservation/scripts/health-report.js`에 `daily_summary 무결성` 체크를 추가해 당일 미마감 데이터를 제외한 스터디룸/일반/합계 구조 이상을 health에서 바로 경고하도록 정리

### 루나 collect 경고 의미 분리 + 한울 국내 0원 응답 사전 차단
- `bots/investment/shared/pipeline-market-runner.js`에서 collect 실패를 핵심 수집(`core`)과 보조 enrichment(`L03/L04/L05`)로 분리하고, `LLM 긴급 차단` 기인 실패도 별도 경고(`collect_blocked_by_llm_guard`)로 표기하도록 보강
- `bots/investment/markets/crypto.js`, `domestic.js`, `overseas.js` 메트릭 로그에 `coreFailed`, `enrichFailed`를 함께 남겨 `/ops-health`나 텔레그램 경고 해석이 과장되지 않도록 정리
- `bots/investment/shared/kis-client.js`에서 국내 현재가 API가 전부 0 스냅샷을 돌려주는 경우를 `거래불가/종목코드 확인 필요` 의미로 다시 분류
- `bots/investment/team/hanul.js`에서 국내 BUY도 해외와 같은 방식으로 현재가 사전검증을 수행해 `0원 응답 종목`은 주문 단계 전에 리스크 거부하도록 변경

### 스카 수동 처리 완료 루프 복구 + 재시작 미해결 요약 정정
- `bots/reservation/manual/reports/pickko-alerts-resolve.js`가 더 이상 깨진 `getDb()`를 참조하지 않고 PostgreSQL `reservation.alerts`에서 unresolved error alerts를 직접 resolve 하도록 복구
- `bots/orchestrator/src/router.js`가 `처리완료`, `해결했어`, `직접 처리했어`, `마스터가 수동으로 처리함` 등 실제 운영 피드백 문구를 받아 즉시 alert resolve 스크립트를 실행하도록 연결
- `bots/reservation/auto/monitors/naver-monitor.js`의 취소 경로에서 이미 종결된 예약(`completed/cancelled/time_elapsed/marked_seen`)은 재시도 없이 건너뛰고 동일 예약의 과거 오류 알림도 함께 해결 처리하도록 보강
- 스카 재시작 시작 보고는 unresolved alert를 그대로 읽지 않고, 각 alert에 대응하는 예약을 다시 조회해 이미 종결된 예약의 과거 실패 알림은 자동 resolve 후 actionable alert만 `미해결 오류 n건` 요약에 남기도록 수정
