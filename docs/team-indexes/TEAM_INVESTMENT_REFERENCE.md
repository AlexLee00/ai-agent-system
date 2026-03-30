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
  - 주식은 `luna.stockStrategyMode` / `luna.stockStrategyProfiles` 기준으로 별도 전략 프로필 운영

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
- [bots/investment/scripts/backfill-signal-block-reasons.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/backfill-signal-block-reasons.js)
- [bots/investment/scripts/runtime-config-suggestions.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/runtime-config-suggestions.js)
- [bots/investment/scripts/review-runtime-config-suggestion.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/review-runtime-config-suggestion.js)
- [bots/investment/scripts/apply-runtime-config-suggestion.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/apply-runtime-config-suggestion.js)
- [bots/investment/scripts/validate-runtime-config-apply.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/validate-runtime-config-apply.js)

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
  - `kis_mode`: 주식 `brokerAccountMode`
  - `kis.paper_trading`: deprecated 레거시 입력
  - `binance_testnet`: 레거시 실험 플래그 (현재 운영 분류에는 미사용)
- 현재 저장 구조는 `paper` 레거시 필드를 일부 유지하지만, 운영 해석과 리포트는 `executionMode / brokerAccountMode` 기준을 우선한다.
- 주식 공격적 매매 기준:
  - `luna.stockStrategyMode.live|paper`
  - `luna.stockStrategyProfiles.aggressive|balanced`
  - 루나는 이 프로필을 기준으로 주식 `minConfidence`, `debateThresholds`, `fastPath` 기준을 선택한다.
  - 네메시스는 `nemesis.thresholds.stockRejectConfidence`, `stockAutoApproveDomestic`, `stockAutoApproveOverseas`를 실제 하드 규칙으로 사용한다.

실패 원인 저장 기준:
- `signals.block_reason`
  - 사람 읽기용 사유 문자열
- `signals.block_code`
  - 운영/분석 자동화용 구조화 코드
- `signals.block_meta`
  - `exchange`, `symbol`, `action`, `amount` 등 실행 맥락
- 자동매매 일지는 시장별 `실패 코드 요약`과 `사람 읽기용 사유`를 함께 보여준다.
- `runtime_config_suggestion_log`
  - 최근 설정 제안 스냅샷 저장
  - `market_summary`, `suggestions`, `actionable_count`, `review_status`, `review_note` 보존
  - `reviewed_at`, `applied_at`으로 검토/반영 시점 추적
  - 승인된 제안은 `apply-runtime-config-suggestion.js`로 `config.yaml` 반영과 `applied` 상태 갱신을 함께 수행
  - 단, 임시 `--config=/tmp/...` 테스트는 미리보기/파일 반영만 하고 DB 상태는 올리지 않음
  - 적용 후에는 `validate-runtime-config-apply.js`로 health와 최근 실행 흐름까지 묶어 재검증 가능
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
  - `legacy_order_rejected`
  - `legacy_executor_failed`

## 자주 쓰는 명령어

```bash
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.js --json
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js --days=1
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js --dry-run
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/backfill-signal-block-reasons.js --days=30
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/runtime-config-suggestions.js --days=14
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/runtime-config-suggestions.js --days=14 --write
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/review-runtime-config-suggestion.js --list
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/review-runtime-config-suggestion.js --id=<suggestion_log_id> --status=approved --note='다음 주 재검토'
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/apply-runtime-config-suggestion.js --id=<suggestion_log_id>
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/apply-runtime-config-suggestion.js --id=<suggestion_log_id> --write
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/validate-runtime-config-apply.js --id=<suggestion_log_id> --days=7
node /Users/alexlee/projects/ai-agent-system/bots/investment/manual/balance/binance-balance.js
```

## 관련 문서

- [TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)
- [COMMUNITY_DRIVEN_AUTOTRADING_IMPROVEMENTS_2026-03-16.md](/Users/alexlee/projects/ai-agent-system/docs/COMMUNITY_DRIVEN_AUTOTRADING_IMPROVEMENTS_2026-03-16.md)
- [PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)
