# MEMORY — 투자팀봇

## 핵심 설정

| 항목 | 값 |
|------|-----|
| 분석 심볼 | BTC/USDT, ETH/USDT (코인) + 005930, 000660 (KIS 국내주식) |
| 타임프레임 | 1h (기본) |
| 최소 확신도 | 50% |
| 단일 포지션 한도 | 총자산 20% |
| 일일 손실 한도 | 5% |
| 손절 기준 | -3% |
| 최대 동시 포지션 | 5개 |

## DB 위치
- `bots/invest/db/invest.duckdb`
- 테이블: analysis, signals, trades, positions

## 운영 로그
- 분석 파이프라인: 10분 주기 (launchd)
- 업비트 브릿지: 1시간 주기 (launchd)

## Phase 1 완료 항목 (2026-03-01)
- DuckDB 스키마 (analysis/signals/trades/positions)
- CCXT 바이낸스/업비트 클라이언트 (드라이런 기본)
- TA 분석가 (RSI/MACD/볼린저밴드)
- 신호 집계기 (claude-sonnet-4-6 판단)
- 리스크 매니저 (4가지 규칙)
- 바이낸스 실행봇 타일러 (Spot, 드라이런)
- 업비트 브릿지 몰리 (KRW↔USDT, 전송)
- launchd 등록 (pipeline.plist, bridge.plist)
- **KIS 국내주식 실행봇 크리스** (`src/kis-executor.js`, 모의투자 기본)
  - lib/kis.js: 토큰캐시·OHLCV·매수매도·잔고
  - DB migration v2: exchange 컬럼 (binance/kis 구분)
  - signal-aggregator KIS 파이프라인 + KIS 전용 LLM 프롬프트
- **KIS API 실연동 완료** (2026-03-01)
  - 실전/모의투자 API 키 이중화 (`kis_app_key` vs `kis_paper_app_key`)
  - VTS TLS 우회, OHLCV `output` 키 수정, 날짜 범위 수정
  - 모의투자 토큰 발급·현재가·OHLCV·드라이런 매수 E2E 검증 완료
  - 텔레그램 알림 정상 동작

## 타임라인

| 날짜 | 주요 마일스톤 |
|------|------------|
| 2026-03-01 | Phase 0 드라이런 운영 + KIS 크리스 구현 + API 실연동 완료 |
| 2026-03-01 | **KIS API 연동 완료 및 파이프라인 활성화** |
| 2026-03-02 | **루나팀 다중심볼+KIS통합강화** |
| 2026-03-02 | **registry.json 현황 업데이트 + KIS Yahoo폴백** |
| 2026-03-02 | **강세/약세 리서처(LU-035) + 성과 리포트(LU-022/024) + ETH 실매수** |
| 2026-03-02 | **LU-035리서처+LU-024리포터+ETH실매수** | LU-035 강세/약세 리서처 signal-aggregator 통합 완성 외 3건 |
| 2026-03-02 | **LU-030펀드매니저+LU-036리스크매니저v2** | LU-030 fund-manager.js — sonnet-4-6 포트폴리오 오케스트레이터 (30분 launchd) 외 2건 |
| 2026-03-02 | **LU-037-백테스팅엔진** | LU-037 scripts/backtest.js — TA전략 역사적 검증 엔진 외 2건 |
| 2026-03-02 | **LU-038 몰리 v2 TP/SL 모니터 구현 완료** | upbit-bridge.js에 checkTpSl() 함수 추가 (진입가±3% 자동 청산) 외 3건 |
| 2026-03-02 | **CL-004 Dev/OPS 분리 구현 완료** | mode.js getModeSuffix() 추가 (DEV:-dev / OPS:'') 외 4건 |
<!-- session-close:2026-03-02:cl004-devops-분리-구현-완료 -->
<!-- session-close:2026-03-02:lu038-몰리-v2-tpsl-모니터-구현-완료 -->
<!-- session-close:2026-03-02:lu037백테스팅엔진 -->
<!-- session-close:2026-03-02:lu030펀드매니저lu036리스크매니저v2 -->
<!-- session-close:2026-03-02:lu035리서처lu024리포터eth실매수 -->
<!-- session-close:2026-03-02:lu035-researcher-lu024-reporter-eth-buy -->
<!-- session-close:2026-03-02:registryjson-현황-업데이트-kis-yahoo -->
<!-- session-close:2026-03-02:루나팀-다중심볼kis통합강화 -->
<!-- session-close:2026-03-01:kis-api-연동-완료-및-파이프라인-활성화 -->

## 개발 방침 (2026-03-02 확정)
- **맥북 환경**: 스카·루나·클로드·메인봇 구현·테스트·안정화 완료까지 진행
- **reporter.js**: 현재 OPS 전환 전 테스트 데이터 수집 목적 → 향후 정식 매매일지 활용
- **OPS 전환**: 맥북 안정화 완료 후 맨 마지막 진행 (절대 규칙)

## Phase 2 예정 (맥미니 이전 후)
- 백테스팅 엔진 (LU-037)
- 선물(Futures) 거래
- ChromaDB 학습 루프 (LU-039)
- GUI (CL-005)
