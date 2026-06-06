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

## 구현 완료 내역 (git 기준, 2026-05~06)

- **S1/S2 파이프라인 정합 (shadow)** — vault RAG shadow outcome attribution C1 `454596784` + vault shadow on-gate `5dbba9f78` + S1.3-3 C2 L2 ON 전환 게이트 `44243aa98`·`0621b9f49` + S2 통합 가드 SHADOW(중복/포지션 방어 일원화) `248553ff9` + S2 entry-trigger materialize preflight SHADOW `5fc27768b`(ops 적용 `9d44b55e8`). 전부 kill switch 기본 OFF, 거래 경로 무변경.
- **가드 Block→Notify 전환 + Self-Tuning** — hard_block/notify/allow 3분류 + guard_events + 효과 측정 + 주간 self-tuning(상세 OPUS 핸드오프 2026-05-27~06-02). HARD limit(자금한도·거래소API·PROTECTED종목·스테이블코인) 보존.
- **자율 학습 루프** — feedback-loop-orchestrator(일 06:00) + loss/win-pattern-extractor + agent-evolution + FinRL-X 4-layer + 동적 유니버스/체제별 가중치 학습 + 승률 우상향 추적.
- **PnL 데이터 정합성** — trade_journal pnl NULL 가드(학습 코어 12곳) + reconcile-open-journals 주기화 `48e707bcd` + hygiene gate reopen `9e952873a`·`ddc94b8e6`.
- **메타 모델(Secondary)** — meta-model 데이터셋/학습 SHADOW(`luna_meta_model_versions`, active=false 기본).

상세 세션 기록: `docs/OPUS_FINAL_HANDOFF.md`.

## 관련 문서

- [TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)
- [COMMUNITY_DRIVEN_AUTOTRADING_IMPROVEMENTS_2026-03-16.md](/Users/alexlee/projects/ai-agent-system/docs/COMMUNITY_DRIVEN_AUTOTRADING_IMPROVEMENTS_2026-03-16.md)
- [PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)
