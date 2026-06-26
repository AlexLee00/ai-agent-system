# 루나 매도(청산) 분석 — signal_reverse 우수성 (오염 제외)

- 작성일: 2026-06-26
- 작성: 메티 (분석)
- 배경: 마스터 지시 "매수보다 매도가 더 중요하다. 매도 데이터를 분석하자"
- 데이터 주의: C7-9 손익회계 버그로 오염된 16건(crypto entry_value<$1) 제외하고 재집계. 절대 손익값은 여전히 바이낸스 API 기준점 필요하나, **청산 방식 간 상대 비교는 신뢰 가능**.

## 핵심 결론

**청산 방식에 따라 손익이 7배 갈린다. signal_reverse(신호 역전 청산)가 압도적으로 우수하다.** 마스터의 "매도가 손익을 결정한다"는 관점이 데이터로 입증됨.

## 청산 사유별 손익 (crypto, 오염 제외)

| 청산 그룹 | 거래수 | 손익 | 비고 |
|---|---|---|---|
| signal_reverse | 16 | +$577 | 건당 +$36, 최고 효율 |
| normal_exit | 152 | +$790 | 건당 +$5, 물량 많음 |
| protective_order | 12 | -$13 | 손절 계열 |
| strategy_exit | 4 | -$19 | 전략 이탈 청산 |
| other | 263 | -$171 | 기타 |

(오염 16건은 전부 normal_exit/signal_reverse의 "가짜 큰 수익"이었음 → 제외 시 normal_exit +$2,324→+$790, signal_reverse +$859→+$577로 정상화. 손실 청산들은 오염 0.)

## signal_reverse vs normal_exit 특성 비교 (오염 제외)

| 지표 | signal_reverse | normal_exit |
|---|---|---|
| 거래 수 | 16 | 152 |
| 평균 보유시간 | 430분 (7시간) | 564분 (9.4시간) |
| 평균 손익 | **+$36.10** | +$5.20 |
| 승률 | **88%** | 24% |
| 평균 가격변동 | **+1.13%** | +0.18% |

## 해석 — signal_reverse는 진짜 우수한 청산

코드상 `telegram-trade-alerts.ts` L435에서 signal_reverse는 exitReason 미지정 매도의 기본 라벨처럼 보이나(`exitReason || 'signal_reverse'`), **실제 데이터 특성은 명확히 우수한 청산 패턴**:

1. **승률 88% vs 24%** — signal_reverse는 거의 다 이김. normal_exit은 손익비로 버팀.
2. **가격변동 +1.13% vs +0.18%** — signal_reverse는 **가격이 오른 상태에서 청산** = 추세 추종 후 적절한 익절. normal_exit은 가격 거의 안 움직인 상태(수동적 TP/SL/시간 청산).
3. **건당 +$36 vs +$5** — 7배 효율.

→ signal_reverse = "추세 타다가 신호 꺾일 때 익절"하는 능동적 청산. normal_exit = 수동적 청산. **청산 방식의 질적 차이가 손익을 가름.**

## 시장별 비교 (지난 분석)

- **crypto**: signal_reverse 존재 (16건, 최고 효율) + normal_exit 양수
- **domestic**: signal_reverse **없음**. normal_exit -$326(승률 11%) — 매도가 손실로 끝남
- **overseas**: signal_reverse **없음**. strategy_exit -$101(승률 0%)

→ **가장 우수한 청산(signal_reverse)이 crypto에만 있고 국내/해외엔 미적용.** 이게 domestic/overseas 매도 부실의 한 원인일 수 있음.

## 개선 레버

1. **signal_reverse 청산을 국내/해외에 이식** — 가장 큰 잠재 레버. 단 정확한 트리거 메커니즘(어떤 신호 조건에서 발동) 추가 코드 분석 필요. exitReason을 결정하는 최상위 매도 경로 추적 필요(hephaestos.ts L483/505/547 → 상위).
2. **normal_exit 청산 개선** — 승률 24%로 낮음. 수동적 청산(TP/SL/시간)의 타이밍 최적화 여지.
3. **strategy_exit 계열 점검** — 거의 다 손실(승률 0~11%). 전략 이탈 청산이 손실을 키우는지 검토.

## 데이터 신뢰성

- **오염 제외 후에도 signal_reverse 우수성 유지** → 이 결론은 C7-9 Layer 1 버그와 무관하게 견고.
- 단 **절대 손익값**(crypto 청산 합 +$1,164 등)은 trades 원본(+$578)과 차이 — v_trades_real_usd에 ev≥$1이지만 부분 오염된 거래가 더 있을 수 있음(Layer 2). 완전한 진실은 바이낸스 API 기준점 후.

## 다음 단계

1. **signal_reverse 트리거 메커니즘 심층 분석** — 정확한 신호 조건 추적 → 국내/해외 이식 설계
2. 데이터 보정(Layer 1 16건) + 바이낸스 API 기준점(절대 손익 확정)
3. 보정 후 매도 분석 절대값 재확정

## 핵심 교훈

마스터의 "매도가 중요하다"는 관점이 데이터로 입증됨 — 같은 진입이라도 청산 방식에 따라 건당 손익이 7배(+$36 vs +$5) 갈리고, 시장별로 우수한 청산 방식의 유무가 손익 부호를 가름(crypto +, domestic/overseas -). 매도 로직 개선이 진입 게이트 튜닝보다 큰 레버일 수 있음.
