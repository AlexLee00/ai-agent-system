# 투자팀봇 (invest) — 변경 이력

> 형식: `[버전] YYYY-MM-DD — 제목`
> 스키마 변경은 `migrations/NNN_name.js`에 별도 기록됨.

---

## [1.3.0] 2026-03-01 — 성과 리포트

### 추가
- `scripts/performance-report.js` — 일간·주간 드라이런 성과 리포트
  - 거래 내역 (BUY/SELL 시각·가격·금액)
  - 실현 손익 (매수/매도 합계 기반)
  - 승률 (매도 완료 기준 buy→sell 매칭)
  - 신호 통계 (분석 실행횟수, BUY/SELL/HOLD, 실행/실패)
  - 현재 포지션 + 미실현 PnL
  - `--mode=weekly` 최근 7일 / `--telegram` 텔레그램 발송 / `--date=YYYY-MM-DD` 특정일
- `package.json` scripts: `report`, `report:weekly` 추가

---

## [1.2.0] 2026-03-01 — DEV/OPS 모드 분리 + 3중 체크 시스템

### 추가
- `lib/mode.js` — DEV/OPS 모드 관리
  - `getMode()`: `INVEST_MODE=ops` 환경변수로 구분
  - `assertOpsReady()`: OPS 진입 5중 가드 (모드·dry_run·API키·비밀·드라이런 여부)
  - `guardRealOrder()`: 실주문 직전 최종 환경 검증
  - `printModeBanner()`: 모드별 배너 출력
- `lib/health.js` — 3중 체크 모듈
  - `preflightSystemCheck()`: 시작 2중 (OPS가드·DB파일·스키마4테이블·포지션무결성·최소3분주기)
  - `preflightConnCheck()`: 시작 3중 (바이낸스 티커·텔레그램 전송 실테스트)
  - `shutdownDB()`: 종료 2중 (pending 롤백·포지션 스냅샷·DB close)
  - `shutdownCleanup()`: 종료 3중 (lock 파일삭제·상태파일·텔레그램 알림)
  - `registerShutdownHandlers()`: SIGTERM/SIGINT/uncaughtException 핸들러
  - `recordHeartbeat()` / `getStatus()`: `/tmp/invest-status.json` 상태 파일
- `src/start-invest-ops.sh` 재작성 — 시작 3중 체크 완전 구현
  - 1중(Shell): self-lock·좀비프로세스·바이낸스 ping·디스크500MB·dry_run=false
  - 2중(Node): `preflightSystemCheck()`
  - 3중(API): `preflightConnCheck()`
  - OPS 5초 카운트다운 (TTY 있을 때만)
- `src/start-invest-bridge.sh` 재작성 — 브릿지 전용 3중 체크
  - 1중(Shell): self-lock·업비트 API ping·dry_run=false·upbit_access_key 길이
  - 2중(Node): `preflightSystemCheck()`
  - 3중(API): `fetchBalance()` 실잔고 조회
- `scripts/health-check.js` — 상태 조회 CLI
  - 프로세스 상태 (PID 생존 여부), 실행 이력, 오픈 포지션 + PnL, 오늘 실현 손익
  - `--watch`: 30초 자동 갱신 / `--json`: JSON 출력

### 변경
- `src/analysts/signal-aggregator.js` — `registerShutdownHandlers([])` 추가, `printModeBanner()` 호출, OPS 모드 시 `assertOpsReady()` 실행
- `src/binance-executor.js` — `guardRealOrder()` 호출, `registerShutdownHandlers([])` 추가
- `secrets.json` — `anthropic_api_key` 빈 문자열로 변경 (환경변수 우선순위 보장)

### DB 스키마 (변경 없음)
- 스키마 버전: v1

---

## [1.1.0] 2026-03-01 — DEV/OPS 분리 (초기)

### 추가
- `lib/mode.js` 초안 — DEV/OPS 모드 개념 도입
- `plist` 파일에 `INVEST_MODE=ops` 환경변수 추가

---

## [1.0.0] 2026-03-01 — Phase 1 최초 구현

### 추가
- 프로젝트 초기 구조 (`bots/invest/`)
- `lib/secrets.js` — secrets.json 로더 + 드라이런 감지
- `lib/db.js` — DuckDB 래퍼 (Promise 패턴)
- `lib/binance.js` — CCXT Binance 클라이언트 (Spot, testnet 지원)
- `lib/upbit.js` — CCXT Upbit 클라이언트
- `lib/signal.js` — 신호 타입 정의 (ACTIONS, SIGNAL_STATUS, ANALYST_TYPES)
- `lib/telegram.js` — 텔레그램 알림 (3회 재시도)
- `src/analysts/ta-analyst.js` — 순수 JS TA 계산기 (RSI14, EMA, MACD, BB20)
- `src/analysts/signal-aggregator.js` — TA→LLM 취합 파이프라인 (claude-sonnet-4-6)
- `src/risk-manager.js` — 규칙 기반 리스크 평가 (포지션크기·일손실·최대포지션·손절)
- `src/binance-executor.js` — 바이낸스 Spot 주문 실행봇
- `src/upbit-bridge.js` — 업비트 잔고 모니터링 + KRW↔USDT 전환
- `scripts/setup-db.js` — DB 초기화 CLI
- `scripts/dry-run-test.js` — 드라이런 전체 흐름 테스트 (9단계)
- `context/IDENTITY.md`, `MEMORY.md`, `CLAUDE_NOTES.md`
- `~/Library/LaunchAgents/ai.invest.pipeline.plist` (10분 주기)
- `~/Library/LaunchAgents/ai.invest.bridge.plist` (1시간 주기)
- `bots/registry.json` — invest 봇 등록

### DB 스키마
- **v1** `migrations/001_initial_schema.js`
  - `analysis` — 분석가 결과 (symbol, analyst, signal, confidence, reasoning, metadata)
  - `signals` — 매매 신호 (symbol, action, amount_usdt, confidence, status)
  - `trades` — 실행 거래 (signal_id, symbol, side, amount, price, dry_run)
  - `positions` — 현재 포지션 (symbol PK, amount, avg_price, unrealized_pnl)

### 리스크 규칙 (하드코딩)
- 단일 포지션 최대: 총자산 20%
- 일일 최대 손실: 5%
- 동시 최대 포지션: 5개
- 손절: -3%
- 주문 범위: 10~1,000 USDT

---

## 향후 계획 (Phase 2+)

| 항목 | 설명 |
|------|------|
| 실 API 키 연결 | 맥미니 이전 후 바이낸스/업비트 실키 설정 |
| 선물(Futures) 거래 | CCXT Binance futures 확장 |
| 백테스팅 엔진 | 맥미니에서 과거 데이터 기반 전략 검증 |
| 감성분석가 | 뉴스/온체인 데이터 연동 |
| OpenClaw 에이전트 | 텔레그램 자연어 명령 처리 |
| DB 마이그레이션 | `scripts/migrate.js`로 스키마 변경 추적 |
