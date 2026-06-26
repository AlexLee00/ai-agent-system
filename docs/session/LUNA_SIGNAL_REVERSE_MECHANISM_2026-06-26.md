# 루나 signal_reverse 청산 메커니즘 + 국내/해외 이식 분석

- 작성일: 2026-06-26
- 작성: 메티 (분석·설계)
- 배경: 매도 분석에서 signal_reverse가 최고 효율 청산(88% 승률, 건당 +$36)으로 확인됨 → "왜 우수한가, 국내/해외 이식 가능한가" 심층 추적
- 선행: `docs/session/LUNA_EXIT_ANALYSIS_2026-06-26.md`

## 핵심 결론

signal_reverse는 **crypto의 LLM 기반 능동 청산**(분석가 신호가 매수→매도/홀드로 전환되면 청산)이다. **국내/해외(hanul)에는 이 로직이 아예 없어** 매도가 부실하다(normal_exit 11% 승률 -$326). `getExitDecisions`는 exchange 파라미터를 이미 받는 구조라 **국내/해외 이식이 구조적으로 가능**하다.

## signal_reverse 메커니즘 (규명 완료)

**호출 흐름:**
- `luna.ts` L548 `getExitDecisions(openPositions, exchange)` → LLM(`LUNA_EXIT_SYSTEM`)이 보유 포지션 평가
- `luna-exit-policy.ts` `buildExitPrompt`가 청산 프롬프트 생성
- 청산 결과가 SELL이면 매도 실행 → `telegram-trade-alerts.ts` L435에서 exitReason 미지정 시 'signal_reverse' 라벨

**청산 SELL 규칙 (luna-exit-policy.ts L64-72):**
- **추세 전환: 분석가 신호가 SELL/HOLD로 전환 시** ← signal_reverse의 본질
- 미실현손익 음수 + 분석가 다수 SELL/HOLD → SELL 우선
- -5% 이하 손실은 반전 근거 없으면 SELL
- 72시간 이상 장기보유는 상승근거 없으면 SELL
- 작은 손실(-1% 이내)+짧은 보유는 HOLD 우선

**즉**: 추세 타다가 분석가 신호가 꺾이는 순간 능동적으로 청산. 데이터와 일치(+1.13% 가격상승 상태에서 88% 승률 = 적절한 익절 타이밍).

## crypto vs 국내/해외 청산 비교 (핵심 차이)

| | crypto (luna.ts) | 국내/해외 (hanul.ts) |
|---|---|---|
| 청산 판단 | `getExitDecisions` LLM 신호역전 청산 ✓ | **없음** ✗ |
| SELL 신호 출처 | LLM 능동 평가 | 외부 신호 받아 실행만 (L797·2020·2062 action 처리) |
| 데이터 결과 | signal_reverse 88% 승률 +$36/건 | normal_exit 11% 승률 -$326 |

**hanul에 `getExitDecisions` 호출이 전혀 없음** (grep 확인). 국내/해외는 BUY/SELL/HOLD action을 외부에서 받아 실행만 하고, crypto 같은 "보유 포지션을 능동적으로 재평가해 청산"하는 로직이 부재. 이것이 국내/해외 매도 부실의 근본 원인.

## 이식 가능성 (긍정적)

- `getExitDecisions(openPositions, exchange)` — **exchange 파라미터를 이미 받음**. crypto/domestic/overseas 모두 호출 가능하게 설계됨.
- `buildExitPrompt(openPositions, exchange)` — exchange별 라벨만 다르고 청산 로직 공통.
- 즉 **코드 구조상 국내/해외 이식 가능** — hanul의 보유 포지션 처리 사이클에 `getExitDecisions` 호출을 추가하면 됨.

## 이식 시 고려사항

1. **장 운영시간 제약** — KIS는 장중에만 청산 가능(`kis-market-hours-guard.ts` 이미 존재). 청산 판단도 시간 게이트 통과 필요.
2. **국내 청산 규칙 차별화** — luna.ts에 이미 국내장 손실 패턴 학습 보임("장시작/마감 진입·1일 초과 보유·-2% 초과 손실에서 반복"). 국내용 청산 규칙은 crypto와 다르게 튜닝 필요.
3. **LLM 호출 비용** — 국내/해외 보유 종목마다 청산 LLM 호출. 비용/레이트 고려.
4. **실거래 청산 로직 변경** — 국내 실매매에 영향. shadow mode로 먼저 검증 권장.

## 다음 단계

1. **국내/해외 signal_reverse 이식 코덱스 명세** — hanul 보유 포지션 사이클에 `getExitDecisions` 추가 + 국내 청산 규칙 튜닝 + shadow mode 검증. 매도 개선의 실질 구현.
2. **이식 전 정밀 추적** — 국내/해외 현재 SELL 신호가 정확히 어디서 생성되는지(신호 DB? KIS 자동 TP/SL?) 확인해 이식 지점 확정.
3. **데이터 보정 후 효과 측정 기준점** — Layer 1 보정 + 바이낸스 API 기준점 확보 후, 이식 전후 매도 성과 비교 가능.

## 핵심 교훈

매도 개선의 **구체적 레버**를 찾음: crypto에만 있는 LLM 신호역전 청산(signal_reverse)을 국내/해외에 이식. 마스터의 "매도가 중요하다"는 방향이 실행 가능한 개선안으로 구체화됨. 진입 게이트는 이미 적정(완화 레버 없음 확정)이므로, **다음 최대 레버는 매도 로직 개선**, 특히 국내/해외 청산 부실 해소.

## 코덱스 명세 작성 완료 (2026-06-26)

이식 설계 정밀화 완료 → 코덱스 명세 작성됨: `docs/codex/SPEC_KIS_SIGNAL_REVERSE_EXIT_2026-06-26.md` (gitignore 작업공간).

**명세 핵심 (3대 변경 + 향후 확장):**
- 변경1: KIS 능동 청산 모니터 신설(`kis-active-exit-monitor.ts`) — `getExitDecisions(positions, 'kis'/'kis_overseas')` 호출 → SELL 판단 시 신호 생성. `LUNA_KIS_ACTIVE_EXIT_ENABLED=false` shadow 기본.
- 변경2: KIS 전용 청산 규칙 분기(luna-exit-policy.ts) — crypto -5%/72h → 국내 -3%/1일/장마감청산.
- 변경3: **시간초과 손실떨이(domestic_holding_limit_24h)를 안전망으로 강등** — 능동청산이 주, 시간초과는 백스톱. 중복신호 방지.
- 향후: 트레일링스탑·부분익절·시장레짐·변동성급등 청산 4종은 signal_reverse 이식 효과 측정 후 별도 명세.

**이식 가능 근거**: `luna-exit-policy.ts`(enrichExitPositions·buildExitPrompt·buildExitFallback)가 이미 거래소 중립 설계 — getExchangeLabel이 국내/미국주식 라벨 분기, 범용 필드(avg_price·amount·unrealized_pnl) 사용. hanul이 getExitDecisions 호출만 안 할 뿐 모듈은 KIS 지원 완비.

**롤아웃**: Phase1(구현+smoke+shadow배포) → Phase2(로그검증 후 enable) → Phase3(효과측정 후 추가로직 판단).
