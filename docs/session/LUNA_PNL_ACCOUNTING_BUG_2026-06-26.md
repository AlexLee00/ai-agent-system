# 루나 손익 회계 다층 버그 진단 (PnL Accounting Multi-Layer Bug)

- 작성일: 2026-06-26
- 작성: 메티 (진단·분석)
- 발견 계기: 마스터의 직관 — "크립토 실계좌는 계속 마이너스인데 데이터는 수익으로 나온다. 떨어졌는데 수익이라니 계산 오류 같다"
- 상태: 진단 완료, 수정 명세 작성 예정
- 심각도: **CRITICAL** — 손익 회계 전반의 신뢰도 문제. 이 데이터로 한 모든 분석(PSR 게이트 검증 포함)의 토대를 흔듦

## 한 줄 요약

`v_trades_real_usd` 뷰가 보여준 crypto +$2,980 수익은 **거짓**이다. 원본 기준 진짜 실현손익은 +$578이며, 그마저도 일부 부풀려져 있어 **마스터 실계좌 마이너스가 진실**이다. 원인은 단일 버그가 아니라 **3층의 회계 결함**이다.

## 발견 경위

매도(청산) 데이터 분석 중, signal_reverse 청산이 89% 승률 +$45 평균으로 비정상적으로 우수하게 나옴. 개별 거래를 보니 ORCA가 entry_value=$0.14인데 pnl=+$94.72 — "0.14달러 넣고 94달러 수익"이라는 불가능한 값. 마스터가 "실계좌는 마이너스인데 이상하다"고 직관적으로 위화감을 지적 → 데이터 무결성 버그 추적 시작.

## 진짜 손익 (거래소별, 원본 trades 기준)

| 거래소 | 매도건수 | 원본 realized_pnl | 단위 | 비고 |
|---|---|---|---|---|
| binance (crypto) | 212 | +$578.2 | USD | 일부 이상치 포함(아래 Layer2) |
| kis (국내) | 39 | -1,165,231 | **KRW(원화!)** | 단위 버그(Layer3) |
| kis_overseas (해외) | 9 | -$77.8 | USD | 정상 |

**crypto: 뷰값 +$2,980 → 원본 +$578 (5배 부풀림, 차이 +$2,402)**

## Layer 1 — trade_journal 부분체결 델타 분할 버그 (가장 심각)

**영향**: crypto 16건, +$1,816 과대 (총 +$2,980의 61%). domestic/overseas는 0건.

**버그 체인 (진원지까지 추적 완료):**
1. 바이낸스 주문이 여러 번 **부분 체결**됨
2. `pending-reconcile-ledger.ts` L341-351이 매 체결을 **"델타(증분)"** 로 기록:
   - `normalizedDeltaFilled = Math.max(0, Number(deltaFilledQty || 0))` — 이번에 추가 체결된 수량
   - `totalUsdt = normalizedDeltaCost > 0 ? normalizedDeltaCost : (normalizedDeltaFilled * unitPrice)`
3. 마지막 **자투리 체결의 델타가 아주 작음** (LUNC: 0.00408개) → trade 객체 amount≈0
4. `telegram-trade-alerts.ts` L358-360이 그 자투리를 entry로 기록:
   - `entry_size: trade.amount || 0` → 0.004
   - `entry_value: trade.totalUsdt || 0` → ≈0
5. 청산 시 이 자투리 trade_journal 레코드에 **전체 exit_value**(~$130)가 매칭
   - `pnl_amount = exit_value - entry_value = 136.89 - 0 = $136.89` (가짜)

**핵심**: entry_price는 정상인데 entry_size/entry_value만 비정상적으로 작음. 부분체결을 N개 조각으로 나눠 기록했는데, 청산은 그 조각 중 하나에 통째로 매칭되는 **분할기록 ↔ 청산매칭 불일치**.

**왜 crypto만**: 바이낸스는 부분 체결이 흔해 델타 분할 발생. KIS(국내/해외)는 체결 방식이 달라 이 패턴 거의 없음.

**증거 (대표 거래):**
| trade_id | symbol | entry_size | entry_value | exit_value | pnl(가짜) | exit_reason |
|---|---|---|---|---|---|---|
| TRD-20260428-008 | LUNC | 0.00408 | $0.0000 | $136.89 | +$136.89 | normal_exit |
| TRD-20260428-016 | PENGU | 0.37 | $0.0038 | $248.38 | +$248.38 | normal_exit |
| TRD-20260426-033 | ORCA | 0.08 | $0.1427 | $94.86 | +$94.72 | signal_reverse |

LUNC 원본 trades 실제값: 매도 2건 realized_pnl_usdt = +$16.42 + $9.71 ≈ **+$26** (뷰값 +$137의 1/5).

**관련 코드:**
- `bots/investment/team/hephaestos/pending-reconcile-ledger.ts` L341-351 (델타 계산)
- `bots/investment/team/hephaestos/telegram-trade-alerts.ts` L358-360 (entry 기록), L241-244 (부분청산 안분)
- `bots/investment/shared/trade-journal-db.ts` insertJournalEntry/closeJournalEntry (호출자 값 저장만, 계산 안 함 — 죄 없음)
- `v_trades_real_usd` 뷰: trade_journal을 환율정규화만 함 (죄 없음 — 소스가 오염)

## Layer 2 — trades 원본 realized_pnl 일부 이상치

**영향**: trades.realized_pnl_usdt도 100% 신뢰 불가. "+$578"도 부풀려졌을 수 있음.

**증거**: NOM/USDT 매도 — amount=43,744 × price=0.01037 = notional $453.6인데 realized_pnl=+$311.5 (**69% 수익률**, 비현실적). 부분체결/매칭의 유사 오차가 trades 원본 계산에도 일부 침투한 것으로 추정.

→ trade_journal보다는 덜 오염됐으나, trades.realized_pnl_usdt도 검증 필요. **진짜 기준점은 바이낸스 API 실잔고로만 확정 가능.**

## Layer 3 — KIS realized_pnl_usdt 원화(KRW) 혼입

**영향**: KIS(국내) 거래의 realized_pnl_usdt 컬럼에 **USD가 아닌 KRW가 그대로** 저장됨.

**증거**: 006340 매도 realized_pnl_usdt = -306,060 (이건 -306,060원 ≈ -$225이지 -$306,060 아님). 종목코드 6자리 = 한국 주식. KIS 39건 합계 -1,165,231(KRW) ≈ -$856(USD).

→ 컬럼명은 `_usdt`인데 KRW가 들어가 통화 단위 불일치. crypto 버그와 **별개의 독립 버그**.

## ⚠️ 과거 분석에 미친 영향 (재검토 필요)

이 오염 데이터(v_trades_real_usd / trade_journal)로 한 모든 분석이 의심됨:

1. **PSR 게이트 462건 실거래 AUC 검증 (DSR→PSR 전환 근거)** — v_trades_real_usd 462 trades로 PSR의 실거래 AUC(0.659)를 검증해 DSR을 PSR로 교체했음. 이 462건에 오염 거래가 섞였다면 AUC 자체가 왜곡. **PSR 전환 근거 재검토 필요.** (단, PSR 게이트의 통계적 우월성은 sim 백테스트에서도 확인됐으므로 전환 방향 자체가 틀린 건 아닐 수 있음 — 실거래 검증 부분만 재확인)
2. **이번 매도(청산) 분석 전부** — signal_reverse +$859(89% 승률), crypto normal_exit +$2,324 등 시장별 청산 손익이 전부 오염된 pnl_amount 기반. **재집계 필요.**
3. **strategy_family 성과 분석** — getStrategyFamilyPerformanceInsight가 pnl_amount/pnl_net 사용. 일부 왜곡 가능.

## 수정 방향 (3층 각각)

**Layer 1 (trade_journal 부분체결):**
- (a) 버그 수정: 부분체결 델타 분할 시 청산 매칭이 entry_value를 올바르게 합산하도록. 또는 자투리(entry_value≈0) 레코드를 청산 매칭에서 제외/병합.
- (b) 데이터 보정: 오염된 crypto 16건을 trades.realized_pnl_usdt(매칭 후) 기준으로 pnl_amount 재계산.

**Layer 2 (trades 이상치):**
- trades.realized_pnl_usdt 계산 로직 검증. 바이낸스 API 실잔고와 대조해 오차 범위 확인.

**Layer 3 (KIS 원화):**
- KIS realized_pnl_usdt를 USD로 정규화(KRW × fx_rate)하거나, 컬럼 의미 명확화(realized_pnl_krw 분리).

## 다음 단계 (우선순위)

1. **★ 바이낸스 실계좌 기준점 확보** — API로 실제 잔고/실현손익 조회. **주체: 마스터 직접 또는 코덱스** (메티는 거래소 인증/금융 데이터 직접 접근 안 함). 메티는 API 조회 설계 명세 작성 가능. 이게 모든 보정의 기준점.
2. **회계 버그 수정 코덱스 명세** — Layer 1 우선(가장 심각), Layer 3 동봉. Layer 2는 기준점 확보 후.
3. **과거 분석 재검토** — PSR 게이트 462건 AUC 재확인 + 매도 분석 재집계.

## 핵심 교훈

- **마스터의 실계좌 대조 직관이 시스템의 가장 깊은 결함을 잡아냄.** "데이터가 수익인데 실계좌가 마이너스"라는 위화감이 단일 뷰 버그가 아니라 회계 시스템 전반의 다층 결함을 들춤.
- **DB 손익 데이터는 현재 신뢰 불가.** 모든 손익 기반 분석/학습은 보정 전까지 유보. 진짜 기준점은 거래소 API 실잔고.
- 부분체결이 흔한 시장(crypto)에서 "델타 분할 기록 ↔ 전체 청산 매칭" 불일치는 회계를 근본적으로 깨뜨림.
