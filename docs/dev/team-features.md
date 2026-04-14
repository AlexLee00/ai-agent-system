# 팀별 기능 목록 — ai-agent-system

> 마지막 업데이트: 2026-03-19

---

## 목차
1. [스카팀 — 스터디카페 예약관리](#1-스카팀--스터디카페-예약관리)
2. [루나팀 — 자동매매](#2-루나팀--자동매매)
3. [클로드팀 — 시스템 유지보수](#3-클로드팀--시스템-유지보수)
4. [전체 요약](#4-전체-요약)

---

## 1. 스카팀 — 스터디카페 예약관리

**위치**: `bots/reservation/`
**상태**: ✅ OPS 모드 실운영 중
**설명**: 네이버 스마트플레이스 신규/취소 예약 → 픽코 키오스크 자동 동기화

### 팀원

| 이름 | 파일 | 역할 |
|------|------|------|
| **스카** | `bots/reservation/` | 메인봇 (OpenClaw 자연어 처리) |
| **앤디** | `auto/monitors/naver-monitor.js` | 네이버 스마트플레이스 모니터링 (5분) |
| **지미** | `auto/monitors/pickko-kiosk-monitor.js` | 키오스크 예약 감지 → 네이버 차단/해제 (30분) |
| **레베카** | `bots/ska/src/rebecca.py` | 매출·예측 분석봇 (Prophet) |
| **이브** | `bots/ska/src/eve.py` | 공공API 환경요소 수집봇 (공휴일·날씨·학사·축제) |

### 자동화 기능 (launchd 상시/스케줄)

| 기능 | 파일 | 주기 | 설명 |
|------|------|------|------|
| 네이버 예약 모니터링 | `auto/monitors/naver-monitor.ts` | 5분 (상시) | source of truth는 TS, 운영 엔트리는 dist runtime |
| 키오스크 예약 감지 | `auto/monitors/pickko-kiosk-monitor.ts` | 30분 | source of truth는 TS, 운영 엔트리는 dist runtime |
| 일일 요약 보고 | `auto/scheduled/pickko-daily-summary.ts` | 09:00 / 00:00 | 당일 예약 현황 + 스터디룸/일반이용 매출 분리 보고 |
| 일일 감사 | `auto/scheduled/pickko-daily-audit.ts` | 08:30 | pending/failed 항목 자동 검증 + 텔레그램 알림 |
| 결제 스캔 | `auto/scheduled/pickko-pay-scan.ts` | 13:00 | 미결제 항목 재조회 |
| 환경요소 수집 | `bots/ska/src/eve.py` | 1시간 | 공휴일·날씨·학사·축제 공공API 수집 |
| 매출 예측 (Prophet) | `bots/ska/src/rebecca.py` | 토요일 18:00 | Prophet 기반 일/주/월 매출 예측 |
| DB 백업 | `scripts/backup-db.ts` | 매일 23:00 | 운영 엔트리는 dist runtime 기준 |
| 로그 로테이션 | `scripts/log-rotate.ts` | 매주 월 00:00 | 10개 로그 파일 copytruncate |
| 헬스 체크 | `scripts/health-check.ts` | 1시간 | naver-monitor 크래시루프 감지 + 텔레그램 |

### 수동 CLI 기능

| 기능 | 파일 | 설명 |
|------|------|------|
| 예약 등록 | `manual/reservation/pickko-accurate.ts` | 픽코 신규 등록 Stage [1~9] |
| 예약 취소 | `manual/reservation/pickko-cancel.ts` | 픽코 취소 + 네이버 해제 Stage [1~10] |
| 예약 조회 | `manual/reservation/pickko-query.ts` | 예약 내역 조회 CLI |
| 미검증 재검증 | `manual/admin/pickko-verify.ts` | pending/failed 항목 픽코 재검증 + 자동 등록 (08:00/14:00/20:00) |
| 회원 관리 | `manual/admin/pickko-member.ts` | 회원 CRUD + AES-256-GCM 암호화 저장 |
| 티켓 관리 | `manual/admin/pickko-ticket.ts` | 이용권 등록/취소 CLI |
| 가동률 리포트 | `manual/reports/occupancy-report.ts` | 룸별·시간대별 가동률 분석 |
| 매출 통계 | `manual/reports/pickko-stats-cmd.ts` | 예약/취소/매출 통계 CLI |
| 매출 확인 | `manual/reports/pickko-revenue-confirm.ts` | 매출 컨펌 CLI |
| 배치 재등록 | `manual/reservation/pickko-reregister-batch.ts` | 일괄 재등록 배치 |

### 빠른 재시작

```bash
# ✅ 코드 수정 후 항상 이것 사용 (직접 launchctl 금지)
bash scripts/reload-monitor.sh
```

### 핵심 라이브러리

| 라이브러리 | 역할 |
|-----------|------|
| `lib/state-bus.ts` | 에이전트 간 통신 (Postgres — agent_state / pickko_lock / pending_blocks) |
| `lib/db.ts` | Postgres 도메인 함수 + 마이그레이션 |
| `lib/pickko.ts` | 픽코 로그인 / 예약 조회 / 회원 검색 |
| `lib/telegram.ts` | Bot API 직접 발송 + pending queue |
| `lib/crypto.ts` | AES-256-GCM 암호화/복호화 |
| `lib/browser.ts` | Puppeteer 런치 옵션 + 다이얼로그 핸들러 |
| `lib/health.ts` | 3중 가동/중지 + 셧다운 핸들러 |
| `lib/error-tracker.ts` | 연속 오류 카운터 |
| `lib/validation.ts` | 전화번호·날짜·시간 정규화 |

### launchd 서비스 목록 (18개)

| 서비스명 | 주기 | 역할 |
|---------|------|------|
| `ai.ska.naver-monitor` | 상시 KeepAlive | 네이버 모니터링 OPS 재시작 루프 |
| `ai.ska.kiosk-monitor` | 30분 | 키오스크 감지 |
| `ai.ska.pickko-daily-summary` | 09:00 / 00:00 | 일일 매출 요약 |
| `ai.ska.pickko-daily-audit` | 08:30 | 일일 감사 |
| `ai.ska.pickko-pay-scan` | 13:00 | 결제 스캔 |
| `ai.ska.pickko-verify` | 08:00 / 14:00 / 20:00 | 미검증 재검증 |
| `ai.ska.today-audit` | 수동 | 오늘 예약 검증 |
| `ai.ska.health-check` | 1시간 | 시스템 헬스 체크 |
| `ai.ska.db-backup` | 매일 23:00 | DB 백업 |
| `ai.ska.log-rotate` | 매주 월 00:00 | 로그 로테이션 |
| `ai.ska.log-report` | 매주 월 09:00 | 주간 로그 리포트 |
| `ai.ska.eve` | 일출/일몰 | 환경요소 수집 |
| `ai.ska.eve-crawl` | 08:00~22:00 1시간 | 크롤링 사이클 |
| `ai.ska.rebecca` | 토요일 18:00 | 매출/예측 분석 |
| `ai.ska.rebecca-weekly` | 매주 월 | 주간 분석 |
| `ai.ska.forecast-daily` | 매일 | Prophet 일별 예측 |
| `ai.ska.forecast-weekly` | 매주 | Prophet 주별 예측 |
| `ai.ska.forecast-monthly` | 매월 | Prophet 월별 예측 |
| `ai.ska.tmux` | 부팅 시 | 원격 작업용 tmux 세션 |

---

## 2. 루나팀 — 자동매매

**위치**: `bots/investment/`
**상태**: 🌙 암호화폐 OPS / 국내외주식 테스트 중
**설명**: 바이낸스(암호화폐) + KIS(국내·미국주식) 자동매매

### 팀원

| 이름 | 파일 | 역할 | LLM |
|------|------|------|-----|
| **루나** | `team/luna.js` | 오케스트레이터 — 신호 수집 → 토론 → 최종 판단 | Haiku(OPS) / Scout(DEV) |
| **아리아** | `team/aria.js` | TA MTF 기술분석 (RSI/MACD/BB/MA/스토캐스틱/ATR) | 규칙 기반 |
| **오라클** | `team/oracle.js` | 온체인·매크로 (공포탐욕/펀딩비/롱숏비/OI) | Scout |
| **헤르메스** | `team/hermes.js` | 뉴스 감성 (CoinDesk/Yahoo/MarketWatch/Naver/DART) | Scout |
| **소피아** | `team/sophia.js` | 커뮤니티 감성 (Reddit/DCInside/CryptoPanic/Naver토론실) | Scout |
| **제우스** | `team/zeus.js` | 강세 리서처 (bull case 토론) | Claude |
| **아테나** | `team/athena.js` | 약세 리서처 (bear case 토론) | Claude |
| **네메시스** | `team/nemesis.js` | 리스크 매니저 (하드 규칙 + LLM) | Haiku(OPS) / Scout(DEV) |
| **헤파이스토스** | `team/hephaestos.js` | 바이낸스 Spot 실행봇 (CCXT) | 규칙 기반 |
| **한울** | `team/hanul.js` | KIS 국내·해외주식 실행봇 | 규칙 기반 |

### 시장별 사이클

| 시장 | 파일 | 주기 | 실행봇 | 상태 |
|------|------|------|--------|------|
| 암호화폐 | `markets/crypto.js` | 30분 (+ BTC ±3% 긴급) | 헤파이스토스 (바이낸스) | 🟢 OPS |
| 국내주식 | `markets/domestic.js` | 30분 (KST 09:00~15:30 장중) | 한울 (KIS) | 🟡 테스트 |
| 미국주식 | `markets/overseas.js` | 30분 (NYSE/NASDAQ 장중, 서머타임 자동) | 한울 (KIS) | 🟡 테스트 |

### 사이클 흐름 (공통)

```
[병렬 수집]
  아리아  TA MTF (5m/1h/4h 또는 일봉/1h)
  오라클  온체인·매크로
  헤르메스 뉴스 감성
  소피아  커뮤니티 감성
       ↓
[루나] 신호 집계 → 강세(제우스)/약세(아테나) 토론
       ↓
[네메시스] 리스크 검토 → 승인/거부
       ↓
[실행봇] 헤파이스토스 / 한울 → DB 기록 + 텔레그램
```

### LLM 정책 v2.1

| 모드 | 루나·네메시스 | 기타 분석가 |
|------|-------------|-----------|
| PAPER_MODE=true (DEV) | Groq Scout (무료) | Groq Scout (무료) |
| PAPER_MODE=false (OPS) | Claude Haiku (유료) | Groq Scout (무료) |

**Groq 계정**: 9개 키 라운드로빈 (429 시 자동 다음 키)

### 핵심 모듈

| 모듈 | 역할 |
|------|------|
| `shared/llm-client.js` | `callLLM(agentName, system, user, maxTokens)` — Haiku/Scout 분기 |
| `shared/cost-tracker.js` | LLM 비용 추적 (일/월 예산 한도, BUDGET_EXCEEDED 시 사이클 중단) |
| `shared/db.js` | DuckDB (신호·분석·거래) + SQLite (상태) |
| `shared/signal.js` | 신호 데이터 구조 & 검증 |
| `shared/report.js` | 텔레그램 알림 |

### launchd 서비스 (6개)

| 서비스명 | 주기 | 역할 |
|---------|------|------|
| `ai.investment.crypto` | 5분 (내부 30분 throttle) | 암호화폐 정상거래 레일 — `INVESTMENT_TRADE_MODE=normal`, executionMode=live / brokerAccountMode=real |
| `ai.investment.crypto.validation` | 15분 (validation canary) | 암호화폐 검증거래 레일 — `INVESTMENT_TRADE_MODE=validation`, 별도 guard scope / 별도 로그 / 더 작은 reserve·position cap·starter size |
| `ai.investment.domestic` | 30분 (장중) | 국내주식 정상거래 레일 — KIS 모의/실계좌 정책에 따라 실행 |
| `ai.investment.domestic.validation` | 30분 (장중) | 국내주식 검증거래 레일 — `INVESTMENT_TRADE_MODE=validation`, 모의투자 기준 canary 관찰 |
| `ai.investment.overseas` | 30분 (장중) | 미국주식 정상거래 레일 — KIS 모의/실계좌 정책에 따라 실행 |
| `ai.investment.overseas.validation` | 30분 (장중) | 미국주식 검증거래 레일 — `INVESTMENT_TRADE_MODE=validation`, 모의투자 기준 canary 관찰 |

### 최근 validation 관찰 요약 (2026-03-19)

- 암호화폐 validation
  - `decision 48 | BUY 2 | approved 2 | executed 2 | trades 2 (LIVE 0 / PAPER 2)`
  - 현재 해석: `승격 후보`
- 국내주식 validation
  - `decision 46 | BUY 3 | approved 3 | executed 1 | trades 1 (LIVE 1 / PAPER 0)`
  - 현재 해석: `승격 후보`
- 미국주식 validation
  - 공용 레일은 준비 완료
  - 장중 + 실제 운영 컨텍스트 표본 추가 관찰 필요

---

## 3. 클로드팀 — 시스템 유지보수

**위치**: `bots/claude/`
**상태**: ✅ DEV 모드 — 점검·알림·패치 티켓까지만 담당
**설명**: 전체 시스템 점검 + 기술 인텔리전스 + PATCH_REQUEST 오케스트레이션

> 클로드팀은 스카팀·루나팀 코드를 **직접 수정하지 않는다**.
> 점검 → 알림 → 패치 티켓 생성까지만 담당.

### 팀원

| 이름 | 파일 | 역할 |
|------|------|------|
| **클로드** | Claude Code CLI | 메인봇 (개발 파트너 — 나) |
| **덱스터** | `src/dexter.js` | 시스템 점검봇 (1시간 주기) |
| **아처** | `src/archer.js` | 기술 인텔리전스봇 (매주 월 09:00) |

### 덱스터 — 시스템 점검봇

| 점검 항목 | 파일 | 확인 내용 |
|---------|------|---------|
| 리소스 | `lib/checks/resources.js` | CPU·메모리·디스크 사용률 |
| 네트워크 | `lib/checks/network.js` | API 연결 + 응답 시간 (바이낸스/업비트/텔레그램/네이버/Anthropic) |
| 봇 가동 | `lib/checks/bots.js` | launchd 상태·PID·종료코드 전체 봇 점검 |
| 스카팀 | `lib/checks/ska.js` | state-bus 에이전트 상태·픽코 락·블록 큐 |
| 오류 로그 | `lib/checks/logs.js` | 최근 100줄 오류/경고 집계 |
| 보안 | `lib/checks/security.js` | 하드코딩 키 스캔 + secrets 권한 + .gitignore |
| DB 무결성 | `lib/checks/database.js` | SQLite·DuckDB 테이블·스키마·포지션 무결성 |
| 코드 무결성 | `lib/checks/code.js` | 체크섬 변경 감지 + git 미커밋 상태 |
| 의존성 보안 | `lib/checks/deps.js` | npm audit + 패키지 최신 여부 |

**실행 명령**:

```bash
npm run dexter              # 기본 점검
npm run dexter:full         # 전체 점검 (npm audit 포함)
npm run dexter:fix          # 자동 수정 + 텔레그램
npm run dexter:daily        # 일일 보고 (텔레그램)
```

### 아처 — 기술 인텔리전스봇 v2.0

| 기능 | 파일 | 설명 |
|------|------|------|
| 데이터 수집 | `lib/archer/fetcher.js` | GitHub Releases·npm Registry·npm audit·웹 서칭 8개 소스 |
| LLM 분석 | `lib/archer/analyzer.js` | Claude Sonnet — AI/LLM 트렌드 분석 + 패치 우선순위 평가 |
| 패치 오케스트레이션 | `lib/archer/patcher.js` | PATCH_REQUEST.md 생성 (urgency: critical→high→medium→low) |
| 리포트 생성 | `lib/archer/reporter.js` | 주간 기술 트렌드 리포트 + 텔레그램 발송 |

> **아처 서칭 범위**: GitHub·npm·AI뉴스 한정
> BTC/ETH 가격, Fear&Greed → 루나팀 전담 (아처 수집 금지)

**실행 명령**:

```bash
npm run archer              # 수집 + 분석 (텔레그램 없음)
npm run archer:telegram     # 수집 + 분석 + 텔레그램
npm run archer:fetch-only   # 수집만 (디버그)
```

### 팀 상태 DB (Team Bus)

**위치**: `~/.openclaw/workspace/claude-team.db`
**모듈**: `lib/team-bus.js`

```bash
npm run status              # 팀 전체 상태 콘솔
npm run patch:status        # 패치 현황 콘솔
```

### launchd 서비스 (3개)

| 서비스명 | 주기 | 역할 |
|---------|------|------|
| `ai.claude.dexter` | 1시간 | 시스템 점검 |
| `ai.claude.dexter.daily` | 매일 08:00 KST | 일일 보고 텔레그램 |
| `ai.claude.archer` | 매주 월 09:00 KST | 기술 트렌드 + 패치 오케스트레이션 |

---

## 4. 전체 요약

| 팀 | 봇 수 | launchd 수 | 상태 | 핵심 기술 |
|----|------|-----------|------|---------|
| **스카** | 5 | 19 | ✅ OPS | Puppeteer, SQLite, Prophet |
| **루나** | 10 | 3 | 🌙 OPS(암)/테스트(주) | CCXT, KIS API, DuckDB, Groq |
| **클로드** | 2 | 3 | ✅ DEV | Claude Sonnet, npm audit, GitHub API |
| **메인봇** | 1 | 1 | ✅ OPS | SQLite 큐, Groq Scout, 3단계 파싱 |

### 공용 인프라

| 패키지 | 위치 | 사용 팀 |
|--------|------|---------|
| `@ai-agent/core` | `packages/core/` | 전체 |
| `@ai-agent/playwright-utils` | `packages/playwright-utils/` | 스카 |
| `_template` | `bots/_template/` | 신규 봇 스캐폴딩 |

### 환경변수 주요 제어 옵션

| 변수 | 기본 | 설명 |
|------|------|------|
| `MODE` | `dev` | `ops`이어야 실제 실행 |
| `DRY_RUN` | `true` | `false`이어야 실제 주문 |
| `PAPER_MODE` | `true` | `executionMode` 레거시 제어값. `false`이면 주문 실행, `true`이면 주문 차단 |
| `OBSERVE_ONLY` | `0` | `1`이면 스카팀 화이트리스트 관찰 모드 |
| `TELEGRAM_ENABLED` | `1` | `0`이면 텔레그램 발송 차단 |

---

---

## 메인봇 (오케스트레이터) — 알람 통합 허브

**위치**: `bots/orchestrator/`
**상태**: ✅ OPS 운영 중 (launchd: `ai.orchestrator`, KeepAlive)
**설명**: 모든 팀 알람을 mainbot_queue(DB)로 수신 → 필터링/배치/무음 처리 → 텔레그램 발송. 사용자 명령 라우팅.

### 핵심 기능

| 기능 | 설명 |
|------|------|
| 알람 통합 | 스카팀/루나팀/클로드팀 모든 알람을 DB 큐로 수신 |
| 필터링 | 무음/야간 보류/배치 집약 3단계 |
| 명령 파싱 | 슬래시→키워드→Groq Scout 3단계 파싱 |
| LLM 토큰 추적 | 전 봇 무료/유료 토큰 사용 통합 기록 |
| 야간 운영 | 22:00~08:00 MEDIUM 이하 보류 → 아침 브리핑 |

### 명령 목록
`/status` `/cost` `/mute` `/unmute` `/luna` `/ska` `/dexter` `/archer` `/brief` `/queue` `/help`

### 팀별 Alert Publisher 클라이언트
| 팀 | 파일 | 모듈 방식 |
|----|------|---------|
| 스카팀 | `bots/reservation/lib/mainbot-client.ts` | TS |
| 루나팀 | `bots/investment/shared/mainbot-client.js` | ESM |
| 클로드팀 | `bots/claude/lib/mainbot-client.js` | CJS |

### launchd 등록
```bash
cp bots/orchestrator/launchd/ai.orchestrator.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/ai.orchestrator.plist
```

→ 상세: `docs/MAINBOT.md`

---

## 변경 이력

| 날짜 | 내용 |
|------|------|
| 2026-03-04 | 메인봇(오케스트레이터) OPS 전환 — 전체 봇 sendTelegram→alert publisher 계열 호출로 교체 시작, time-mode.js 루나팀 연동 |
| 2026-03-03 | 최초 작성 — 스카팀(v3.0 구조 반영) + 루나팀(Phase 3-A/B) + 클로드팀(덱스터/아처 v2.0) |
