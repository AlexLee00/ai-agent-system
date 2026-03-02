# MEMORY — 투자팀봇

## 핵심 설정

| 항목 | 값 |
|------|-----|
| 분석 심볼 | BTC/USDT, ETH/USDT (코인) + 005930, 000660 (KIS, secrets.kis_symbols) |
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
- 타일러: 바이낸스 실행봇 (Spot, 드라이런)
- 몰리: 업비트 브릿지 (KRW↔USDT, 전송)
- launchd 등록 (pipeline.plist, bridge.plist)
- **크리스**: KIS 국내주식 실행봇 (`src/kis-executor.js`) — 모의투자 기본
  - lib/kis.js (토큰캐시·OHLCV·매수매도·잔고)
  - DB migration v2: exchange 컬럼 (binance/kis)
  - signal-aggregator: KIS 파이프라인 + KIS 전용 LLM 프롬프트

## KIS API 연동 검증 결과 (2026-03-01)
- 모의투자 토큰 발급: ✅ (openapivts:9443, TLS rejectUnauthorized:false)
- 현재가 조회 (005930): ✅ 216,500원 정상
- OHLCV 조회 (10개): ✅ output 필드, 날짜 범위 자동 계산
- 드라이런 매수/매도: ✅ 현재가 기반 수량 계산 정상
- 잔고 조회: MCA00124 (포털에서 계좌-앱키 연동 필요 — 사용자 직접 수행)

## lib/kis.js 확정 사항
- tr_id: 매수 `TTC0012U`, 매도 `TTC0011U` (V/T prefix 자동)
- hashkey: POST 주문 시 `/uapi/hashkey` 발급 후 헤더 첨부
- VTS 포트: 9443 (동작 확인, 29443은 미테스트)
- OHLCV: `FHKST01010400`/`inquire-daily-price`, `output || output2` fallback

## KIS 파이프라인 활성화 완료 (2026-03-01)
- signal-aggregator.js: KIS 파이프라인 정상 실행 (005930, 000660 OHLCV → TA → LLM)
- kis-executor.js: 드라이런 BUY/SELL 정상 → DB 기록 + 텔레그램 KRW 포맷
- telegram.js: notifyKisSignal, notifyKisTrade 추가 (KRW 원화 포맷)
- KIS API 제한: inquire-daily-price 최대 30건 → MACD(35기간 필요)은 null, RSI+BB로 분석

## 다음 작업
- KIS 모의투자 실주문 테스트 (`dry_run: false`) — 스카팀 포캐스트 버그 수정 완료로 진행 가능
- KIS 실전 전환 시: `kis_paper_trading: false` + IP 화이트리스트 등록
- Phase 2 (맥미니 이전 후): WebSocket 실시간 체결가
<!-- session-close:2026-03-01:kis-api-연동-완료-및-파이프라인-활성화 -->

<!-- session-close:2026-03-01:kis-api-연동-검증-완료-drrun-정상 -->

## Phase 2 예정 (맥미니 이전 후)
- 실 API 키 연결 (바이낸스/업비트/KIS)
- WebSocket 실시간 체결가 (KIS Phase 2)
- 백테스팅 엔진
- 선물(Futures) 거래
- 감성/온체인 분석가 추가
