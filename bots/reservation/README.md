# 📅 예약관리봇 (스카)

네이버 스마트플레이스 신규/취소 예약 → 픽코 키오스크 자동 동기화 봇

**현재 상태: ✅ OPS 모드 실운영 중**

---

## 시스템 구조

```
[네이버 스마트플레이스]
        ↓ 신규 예약 감지 (5분 주기)     ↓ 취소 감지 (교차검증)
[dist/.../naver-monitor.js]                ↓ currentCancelledList 비교
        ↓ runPickko()               runPickkoCancel() / 이용완료 추정 스킵
[dist/.../pickko-accurate.js]      [dist/.../pickko-cancel.js]
   Stage [1-9] 자동 등록                  취소 처리 [1-10]
        ↓
[픽코 키오스크] ← 예약 등록+결제 / 취소 상태 변경
        ↓
[Postgres] ← 예약 이력 + AES-256-GCM 암호화 + agent_state / pickko_lock / pending_blocks
        ↓
[Telegram/OpenClaw] ← 운영 알람·리포트
```

---

## 디렉토리 구조

TS 본문이 source of truth이고, `.js` / `.legacy.js`는 런타임 호환 레일이다.
운영 launchd와 shell wrapper는 점진적으로 `dist/ts-runtime` 엔트리를 직접 보도록 정리 중이다.

관련 정책:
- `context/SKA_LEGACY_RUNTIME_POLICY_2026-04-13.md`

```
reservation/
├── auto/
│   ├── monitors/
│   │   ├── naver-monitor.ts          # 앤디: 네이버 모니터링 + 픽코 트리거 (source of truth)
│   │   ├── pickko-kiosk-monitor.ts   # 지미: 키오스크 예약 감지 + 네이버 차단 (source of truth)
│   │   ├── start-ops.sh              # OPS 자동 재시작 루프 (naver-monitor)
│   │   ├── run-kiosk-monitor.sh      # 키오스크 모니터 래퍼 (launchd)
│   │   └── run-today-audit.sh        # 오늘 예약 검증 래퍼 (08:30 KST)
│   └── scheduled/
│       ├── pickko-daily-summary.ts   # 일일 요약 (자동, source of truth)
│       ├── pickko-daily-audit.ts     # 일일 감사 (자동, source of truth)
│       ├── pickko-pay-scan.ts        # 결제 스캔 (자동, source of truth)
│       ├── run-daily-summary.sh      # 래퍼
│       ├── run-audit.sh              # 래퍼
│       └── run-pay-scan.sh           # 래퍼
├── manual/
│   ├── reservation/
│   │   ├── pickko-accurate.ts        # 예약 등록 Stage [1-9] (source of truth)
│   │   ├── pickko-cancel.ts          # 예약 취소 Stage [1-10] (source of truth)
│   │   ├── pickko-cancel-cmd.ts      # 취소 CLI
│   │   ├── pickko-register.ts        # 등록 CLI
│   │   └── pickko-query.ts           # 조회
│   ├── admin/
│   │   ├── pickko-member.ts          # 회원 관리
│   │   ├── pickko-ticket.ts          # 티켓 관리
│   │   ├── pickko-verify.ts          # pending/failed 재검증
│   │   └── run-verify.sh             # 래퍼
│   └── reports/
│       ├── occupancy-report.ts       # 가동률 리포트
│       ├── pickko-alerts-query.ts    # 알림 조회
│       ├── pickko-stats-cmd.ts       # 통계 CLI
│       ├── pickko-revenue-confirm.ts # 매출 확인
│       ├── pickko-pay-pending.ts     # 결제 대기 조회
│       └── log-report.sh             # 로그 분석 리포트
├── lib/
│   ├── state-bus.ts      # ★ 에이전트 간 통신 버스
│   ├── pickko.ts         # 핵심 픽코 엔진
│   ├── db.ts             # Postgres + 마이그레이션
│   ├── validation.ts     # 전화번호/날짜/시간 정규식 변환
│   ├── crypto.ts         # AES-256-GCM 암호화
│   ├── telegram.ts       # 텔레그램 알림
│   ├── browser.ts        # Puppeteer 설정
│   ├── health.ts         # 프리플라이트 + 셧다운 핸들러
│   ├── mode.ts           # DEV/OPS 분리
│   ├── status.ts         # 프로세스 상태 파일
│   ├── error-tracker.ts  # 연속 오류 카운터
│   ├── args.ts           # parseArgs() — 불리언 플래그 지원
│   ├── cli.ts            # outputResult, fail
│   ├── formatting.ts     # toKoreanTime, formatPhone
│   ├── files.ts          # loadJson, saveJson
│   ├── secrets.ts        # loadSecrets()
│   ├── utils.ts          # delay, log
│   ├── vip.ts            # VIP 배지
│   └── pickko-stats.ts   # 픽코 통계
├── migrations/
│   ├── 001_initial_schema.ts
│   ├── 002_daily_summary_columns.ts
│   └── 003_agent_state.ts  # ★ agent_state / pickko_lock / pending_blocks
├── src/                    # 진단·테스트 도구 (비자동화)
│   ├── analyze-booking-page.ts
│   ├── backfill-study-room.ts
│   ├── bug-report.ts
│   ├── check-naver.ts
│   ├── get-naver-html.ts
│   ├── init-naver-booking-session.ts
│   ├── inspect-naver.ts
│   ├── test-kiosk-register.ts
│   └── test-nlp-e2e.ts
├── secrets.json            # 네이버/픽코 로그인 정보 (git 제외)
└── package.json
```

---

## 매출 축 기준 (2026-03-25)

`reservation.daily_summary`는 현재 두 가지 서로 다른 축을 함께 보관한다.

- `total_amount`, `room_amounts_json`
  - 예약합계 축
  - 예약/이용 검색 기준 운영 합계
- `general_revenue`, `pickko_study_room`
  - 픽코 직접매출 축
  - 현재 운영/예측/worker 미러의 실매출 기준
- `recognized_total_revenue`
  - 계산식: `general_revenue + pickko_study_room`

현재 source of truth:

- 운영 매출 조회
- 스카 읽기 명령
- 대시보드
- 예측/리뷰
- worker 매출 미러

위 경로는 모두 `recognized_total_revenue = general_revenue + pickko_study_room`를 우선 기준으로 본다.

`total_amount`는 지금 당장 필요한 구조에서는 예약합계/호환용/fallback trace 필드로 유지한다.
나중에 확장할 구조에서는 booking-axis와 recognized-axis를 별도 모델로 분리하는 것이 바람직하다.

---

## 에이전트 통신 (v3.0 신규)

`lib/state-bus.ts` — Postgres 기반 에이전트 간 통신:

| 테이블 | 역할 |
|--------|------|
| `agent_state` | 앤디/지미/수동 상태 공유 (idle/running/error) |
| `pickko_lock` | 픽코 어드민 단독접근 뮤텍스 (TTL 5분) |
| `pending_blocks` | 앤디→지미 블록 요청 큐 |

```javascript
// 사용 예
const sb = require('./lib/state-bus');
sb.updateAgentState('andy', 'running', '모니터링 사이클 #1');
const ok = sb.acquirePickkoLock('jimmy');   // 픽코 락 획득
sb.releasePickkoLock('jimmy');              // 해제
```

---

## 실행

```bash
# OPS 모드 시작 (자동 재시작 루프)
launchctl load ~/Library/LaunchAgents/ai.ska.naver-monitor.plist

# 로그 확인
tail -f /tmp/naver-ops-mode.log

# 수동 재검증
node dist/ts-runtime/bots/reservation/manual/admin/pickko-verify.js

# dry-run
node dist/ts-runtime/bots/reservation/manual/admin/pickko-verify.js --dry-run
```

---

## 주요 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `MODE` | dev | `ops` = 전체 고객, `dev` = 화이트리스트만 |
| `NAVER_INTERVAL_MS` | 300000 | 모니터링 주기 (ms, ops 기본 5분) |
| `PICKKO_ENABLE` | 0 | 픽코 자동 등록 활성화 |
| `PICKKO_CANCEL_ENABLE` | 0 | 픽코 자동 취소 활성화 |
| `PICKKO_PROTOCOL_TIMEOUT_MS` | 300000 | 픽코 브라우저 프로토콜 타임아웃 |
| `OBSERVE_ONLY` | 0 | 1 = 픽코 실행 없이 관찰만 |

---

## DEV / OPS 모드 (절대 규칙)

```
DEV 모드: 화이트리스트 2명만 테스트
  - 이재룡 (010-3500-0586) 사장님
  - 김정민 (010-5435-0586) 부사장님

OPS 모드: 사장님 협의 후 전환. 모든 고객 번호 처리.
OPS 오류 발생 시: 자동 알람 → 수동 처리 (자체 해결 금지)
```

---

## 관련 문서

- `context/DEV_SUMMARY.md` — 개발 현황 전체 요약
- `context/HANDOFF.md` — 최신 인수인계 (모델 교체 시 참조)
- `VALIDATION_RULES.md` — 데이터 검증 규칙
- `IMPLEMENTATION_CHECKLIST.md` — 코드 리뷰 체크리스트
