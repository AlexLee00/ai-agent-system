# 핸드오프: 루나 실거래 흑자 확인 + KIS 적자 원인 (2026-06-02)

> 작성: 메티 · 다음 세션 착수용 · 6세션 "알파 없음" 진단 정정

## 1. 이번 세션의 큰 전환 (핵심)
**메티의 6세션 "신호 R&D 부재 / 알파 없음" 진단은 핵심적으로 틀렸음.** candidate_backtest_status(기술적 4전략 grid)만 보고 부분을 전체로 오인.

### 1-1. 루나 신호 체계 전체 그림
- 입력: 기술적 4전략 grid(candidate_backtest_status, OOS 과적합) + 9개 SHADOW evidence.
- 9 SHADOW: market_regime_llm / entry_decision_llm / dynamic_tpsl / meta_neural_reflexion / factor_model / stat_arb / rl_policy / monte_carlo_stress / communication_infra.
- hybrid promotion gate(luna-hybrid-promotion-gate.ts, buildLunaHybridPromotionGateReport :259): 신호 점수 종합이 아니라 9 SHADOW freshness + phase 계약 + 보안 + 통신 거버넌스 게이트. promotionReady 항상 false, promotionPolicy=manual_master_approval_required_after_shadow_observation. 승격은 마스터 수동.

### 1-2. 실거래 성과 (trade_journal, 통화 혼재 - market별 분리 필수)
| market | 건수 | 손익(거래통화) | USD 환산(~1370) | 승률 |
|---|---|---|---|---|
| crypto | 299 | +3,525 USDT | ~+$3,525 | 31.8% |
| domestic(KIS) | 46 | -1,054,563 KRW | ~-$770 | 15.2% |
| overseas(KIS) | 8 | -74.93 USD | -$75 | 25.0% |
- 순익 약 +$2,680 USD (crypto 주도). 기술적 grid 과적합에도 실거래 흑자.
- 메모리 "-$770K"는 단위 오해 실증: domestic -1,054,563 KRW를 USD로 착각한 것. 실제 -$770.
- v_trades_real_usd view는 전체 스키마에 없음(메모리 부정확). trade_journal 직접 집계. 통화 컬럼 없음 → market으로 추론(crypto USDT, domestic KRW, overseas USD).

### 1-3. KIS 적자 원인 (domestic)
- 승률 15.2%(7승 39패)가 핵심. 손익비는 좋음(win +30.4% / loss -7.1%, 약 4:1).
- 손실 덩어리(전체 -1,055K의 92%): normal_exit 18건 -444K(진입 약신호) / force_exit 7건 -274K / orphan_cleanup 5건 -254K(승 0, 운영 결함 의심).
- 유일 흑자: strategy_exit(SMA 규칙) 4건 +29K.

## 2. 다음 세션 착수점 (우선순위)
1. orphan_cleanup 원인 추적: 전략 손실인지 체결/주문 추적 버그(운영 결함)인지. 운영 결함이면 -254K 즉시 차단 가능. exit_match_source / exit_order_ids / exit_fill_ids 단서. orphan_cleanup 호출 코드 위치.
2. KIS 진입 신호 품질: 승률 15%(normal_exit -444K). 어떤 신호로 진입하는지, 왜 대부분 하락하는지.
3. 9 SHADOW OOS 성과 측정 체계(중기): factor_model_shadow처럼 랭킹/출력만 쌓고 성과 미평가인 SHADOW가 많을 가능성. 단 실거래 흑자라 급하지 않음.

## 3. 정직 메모 (진단 궤적)
- 6세션간 기술적 grid만 보고 "알파 없음" 단정 → 9 SHADOW + hybrid gate + 실거래 흑자(+$2,680) 놓침.
- 신호 학습 SHADOW(직전 세션 luna_signal_policy_shadow)는 dry-run에서 baseline 개선 0이었으나, 이는 "기술적 grid 재집계"의 한계였고 루나 전체와 무관. auto 커밋됨.
- 교훈: 부분(한 테이블)을 전체로 단정하지 말 것. trade_journal 실손익이 닻.

## 4. 불변 컨텍스트
- 3역할(메티 설계·검증 / 코덱스 구현 / 마스터 승인). 메티 코드·DB·git·launchd 직접 실행 금지.
- DB jay(investment 스키마). 경로 /Users/alexlee/projects/ai-agent-system. crypto live 무중단(흑자 견인).
- 통화 합산 금지(KRW/USD 분리). 환율 대략 1,370 KRW/USD.
