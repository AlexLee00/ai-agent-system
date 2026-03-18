# 루나 참조 문서

## 역할

- 암호화폐/국내장/해외장 자동매매
- 시장별 분석, 리스크 승인, 실행, 리뷰 자동화

## 핵심 기능

- `luna` 최종 판단
- `nemesis` 리스크 승인
- `hanul` KIS 실행
- 시장별 일일/주간 리뷰
- `runtime_config` 기반 공격성/보수성 조정

## 핵심 진입점

- [bots/investment/team/luna.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/luna.js)
- [bots/investment/team/nemesis.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/nemesis.js)
- [bots/investment/team/hanul.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/hanul.js)
- [bots/investment/markets/crypto.js](/Users/alexlee/projects/ai-agent-system/bots/investment/markets/crypto.js)
- [bots/investment/markets/domestic.js](/Users/alexlee/projects/ai-agent-system/bots/investment/markets/domestic.js)
- [bots/investment/markets/overseas.js](/Users/alexlee/projects/ai-agent-system/bots/investment/markets/overseas.js)

## 핵심 스크립트

- [bots/investment/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.js)
- [bots/investment/scripts/trading-journal.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js)
- [bots/investment/scripts/weekly-trade-review.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js)

## 운영 설정

- [bots/investment/config.yaml](/Users/alexlee/projects/ai-agent-system/bots/investment/config.yaml)
- [bots/investment/shared/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/runtime-config.js)
- [bots/investment/shared/secrets.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/secrets.js)
- [bots/investment/shared/report.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/report.js)

모드 기준:
- `executionMode`
  - `live`: 실제 주문 실행
  - `paper`: 실제 주문 차단
- `brokerAccountMode`
  - `real`: 실계좌
  - `mock`: 주식용 모의투자 계좌
- 시장별 적용 원칙
  - 암호화폐: `brokerAccountMode=real`만 사용
  - 국내/해외주식: `brokerAccountMode=mock/real` 사용 가능
- 레거시 설정 매핑
  - `PAPER_MODE` / `trading_mode`: `executionMode`
  - `kis.paper_trading`: 주식 `brokerAccountMode`
  - `binance_testnet`: 레거시 실험 플래그 (현재 운영 분류에는 미사용)
- 현재 저장 구조는 `paper` 레거시 필드를 일부 유지하지만, 운영 해석과 리포트는 `executionMode / brokerAccountMode` 기준을 우선한다.

실패 원인 저장 기준:
- `signals.block_reason`
  - 사람 읽기용 사유 문자열
- `signals.block_code`
  - 운영/분석 자동화용 구조화 코드
- `signals.block_meta`
  - `exchange`, `symbol`, `action`, `amount` 등 실행 맥락
- 대표 코드
  - `risk_rejected`
  - `safety_gate_blocked`
  - `nemesis_error`
  - `min_order_notional`
  - `max_order_notional`
  - `missing_position`
  - `capital_guard_rejected`
  - `capital_circuit_breaker`
  - `position_sizing_rejected`
  - `position_mode_conflict`
  - `paper_fallback`
  - `broker_execution_error`

## 자주 쓰는 명령어

```bash
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.js --json
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js --days=1
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js --dry-run
node /Users/alexlee/projects/ai-agent-system/bots/investment/manual/balance/binance-balance.js
```

## 관련 문서

- [TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)
- [COMMUNITY_DRIVEN_AUTOTRADING_IMPROVEMENTS_2026-03-16.md](/Users/alexlee/projects/ai-agent-system/docs/COMMUNITY_DRIVEN_AUTOTRADING_IMPROVEMENTS_2026-03-16.md)
- [PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)
