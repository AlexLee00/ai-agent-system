# CLAUDE_NOTES — 투자팀봇 행동 지침

_최종 업데이트: 2026-03-01_

## 텔레그램 명령어

| 명령 | 동작 |
|------|------|
| `/포지션` | 현재 오픈 포지션 조회 |
| `/잔고` | 바이낸스 + 업비트 잔고 |
| `/신호` | 최근 신호 목록 |
| `/수익` | 오늘 실현 수익 |
| `/분석 BTC/USDT` | 즉시 TA 분석 실행 |
| `/드라이런 BUY BTC/USDT 100` | 드라이런 주문 테스트 |

## 주의사항

1. **실거래 전**: secrets.json에 API 키 설정 + `dry_run: false` 변경
2. **바이낸스 API 보안**: IP 화이트리스트 + 출금 권한 비활성화
3. **업비트 출금**: 별도 키 분리 필수
4. **손절 규칙**: 코드 변경 없이 임의 무시 금지

## 드라이런 확인
```bash
node bots/invest/scripts/dry-run-test.js
```

## 신호 흐름
```
[코인]  TA분석가(binance OHLCV) → DB(analysis) → 신호집계기(LLM) → DB(signals) → 리스크매니저 → 타일러(binance-executor) → DB(trades)
[KIS]   신호집계기(kis OHLCV+TA) → DB(analysis) → LLM → DB(signals,exchange='kis') → 크리스(kis-executor) → DB(trades)
```

## KIS 크리스 (2026-03-01 추가)
- 파일: `src/kis-executor.js` / KIS 클라이언트: `lib/kis.js`
- 모의투자: `kis_paper_trading: true` (기본) → `openapivts.koreainvestment.com`
- 실전 전환: secrets.json `kis_paper_trading: false` + IP 화이트리스트 등록
- 드라이런: `node src/kis-executor.js --dry-run --action=BUY --symbol=005930 --amount=500000`
- KIS 심볼: 6자리 숫자 `005930`(삼성전자), `000660`(SK하이닉스)
- DB exchange 컬럼: migration v2로 추가 (binance/kis 구분)
- API 키 구조: 실전(`kis_app_key/secret`) / 모의투자(`kis_paper_app_key/secret`) 분리
- VTS TLS: 모의투자 서버 인증서 CN 불일치 → `rejectUnauthorized:false` (모의투자 한정)
- 토큰 캐시: `/tmp/kis-token.json`(실전), `/tmp/kis-token-paper.json`(모의투자) 분리

<!-- session-close:2026-03-01:kis-api-연동-완료-및-파이프라인-활성화 -->
#### 2026-03-01 ✨ KIS API 연동 완료 및 파이프라인 활성화
- VTS 포트 29443 수정 (기존 9443 오류)
- 잔고 조회 성공 (모의투자 3천만원 확인)
- KIS 파이프라인 signal-aggregator 활성화
- notifyKisSignal·notifyKisTrade 추가 (원화 포맷)
- kis-executor.js notifyKisTrade 교체
- 관련 파일: `lib/kis.js|lib/telegram.js|src/analysts/signal-aggregator.js|src/kis-executor.js|secrets.json`
<!-- session-close:2026-03-01:kis-api-연동-완료-및-파이프라인-활성화:end -->

<!-- session-close:2026-03-02:루나팀-다중심볼kis통합강화 -->
#### 2026-03-02 ✨ 루나팀 다중심볼+KIS통합강화
- 절대규칙 업데이트(루나팀=암호화폐·국내외주식)
- LU-020 다중심볼 BTC/ETH/SOL/BNB getSymbols()
- LU-021 KIS 6지표 풀분석(이평정배열/스토캐스틱/ATR/거래량)
- isKisMarketOpen() 장중필터(09:00~15:30 KST)
- signal-aggregator 코인+KIS 통합 파이프라인
- 관련 파일: `bots/invest/lib/secrets.js|bots/invest/src/analysts/signal-aggregator.js|bots/invest/secrets.json|bots/invest/secrets.example.json`
<!-- session-close:2026-03-02:루나팀-다중심볼kis통합강화:end -->

<!-- session-close:2026-03-02:registryjson-현황-업데이트-kis-yahoo -->
#### 2026-03-02 ✨ registry.json 현황 업데이트 + KIS Yahoo폴백
- registry.json 루나팀 실제 상태 반영(온체인·뉴스·감성 dev로 정정)
- registry.json 제이슨 파이프라인 상세 명시(6지표·3TF·4심볼)
- registry.json model/logFile/launchd 실제값 반영
- KIS fetchOHLCV Yahoo Finance 폴백(150개 이력, MACD·MA60·MA120 활성화)
- 관련 파일: `bots/registry.json|bots/invest/lib/kis.js`
<!-- session-close:2026-03-02:registryjson-현황-업데이트-kis-yahoo:end -->

<!-- session-close:2026-03-02:lu035리서처lu024리포터eth실매수 -->
#### 2026-03-02 ✨ LU-035리서처+LU-024리포터+ETH실매수
- LU-035 강세/약세 리서처 signal-aggregator 통합 완성
- LU-022/024 성과 리포트 reporter.js 구현 (일/주/월, launchd 22:00)
- ETH/USDT 0.0682 실거래 매수 (.25)
- 맥북 개발 방침 확정 + 개발 우선순위 재조정 문서 반영
- 관련 파일: `bots/invest/src/reporter.js|bots/invest/src/analysts/signal-aggregator.js|bots/invest/context/DEV_SUMMARY.md`
<!-- session-close:2026-03-02:lu035리서처lu024리포터eth실매수:end -->

<!-- session-close:2026-03-02:lu030펀드매니저lu036리스크매니저v2 -->
#### 2026-03-02 ✨ LU-030펀드매니저+LU-036리스크매니저v2
- LU-030 fund-manager.js — sonnet-4-6 포트폴리오 오케스트레이터 (30분 launchd)
- LU-036 risk-manager.js v2 — ATR변동성·상관관계·시간대·LLM haiku 4단계 조정
- registry.json 펀드매니저·리포터 서브봇 등록
- 관련 파일: `bots/invest/src/fund-manager.js|bots/invest/src/risk-manager.js|bots/registry.json`
<!-- session-close:2026-03-02:lu030펀드매니저lu036리스크매니저v2:end -->

<!-- session-close:2026-03-02:lu037백테스팅엔진 -->
#### 2026-03-02 ✨ LU-037-백테스팅엔진
- LU-037 scripts/backtest.js — TA전략 역사적 검증 엔진
- 4개 심볼 1d/4h 백테스트 + 텔레그램 발송
- 인사이트: SOL/BNB 수익팩터 2.0 수준 / BTC/ETH 하락장 TA진입 취약
- 관련 파일: `bots/invest/scripts/backtest.js`
<!-- session-close:2026-03-02:lu037백테스팅엔진:end -->

<!-- session-close:2026-03-02:lu038-몰리-v2-tpsl-모니터-구현-완료 -->
#### 2026-03-02 ✨ LU-038 몰리 v2 TP/SL 모니터 구현 완료
- upbit-bridge.js에 checkTpSl() 함수 추가 (진입가±3% 자동 청산)
- ai.invest.tpsl launchd 등록 (5분 주기 DRY_RUN)
- marketSell + db 연동 + 텔레그램 알림
- 드라이런 테스트 통과 (BTC/USDT -2.03% SL 조건 미달 정상)
- 관련 파일: `bots/invest/src/upbit-bridge.js`
<!-- session-close:2026-03-02:lu038-몰리-v2-tpsl-모니터-구현-완료:end -->

<!-- session-close:2026-03-02:cl004-devops-분리-구현-완료 -->
#### 2026-03-02 ✨ CL-004 Dev/OPS 분리 구현 완료
- mode.js getModeSuffix() 추가 (DEV:-dev / OPS:'')
- health.js STATUS_FILE 동적화 (/tmp/invest-status-dev.json vs invest-status.json)
- dexter bots.js 루나팀 5개 서비스 + DEV/OPS 상태 분리 체크
- switch-to-ops.sh 전환 체크리스트 스크립트 신규
- dry_run=false 위험 감지 → true 복구
- 관련 파일: `bots/invest/lib/mode.js`, `bots/invest/lib/health.js`, `bots/claude/lib/checks/bots.js`, `bots/invest/scripts/switch-to-ops.sh`
<!-- session-close:2026-03-02:cl004-devops-분리-구현-완료:end -->

<!-- bug-tracker:maintenance:start -->
| 날짜 | 항목 | 상태 |
|------|------|------|
| 2026-03-01 | KIS API 연결 + 실전/모의투자 키 이중화 | ✅ |
<!-- bug-tracker:maintenance:end -->
