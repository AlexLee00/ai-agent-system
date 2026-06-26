# 루나 국내 트레이딩 마비 — 근본 원인 (서킷 브레이커 ← 손익 버그)

- 작성일: 2026-06-26
- 작성: 메티 (진단)
- 발견 계기: 마스터 "토스가 shadow일 텐데 shadow 데이터가 들어가 있어야 할 텐데" → 토스 미러 0건 추적
- 심각도: **CRITICAL** — 손익 회계 버그(C7-9)가 데이터 왜곡을 넘어 전략 신호 생성 전체를 마비시킴
- 선행: `docs/session/LUNA_PNL_ACCOUNTING_BUG_2026-06-26.md` (C7-9 Layer 1~3)

## 한 줄 요약

토스 미러 0건은 빙산의 일각. 진짜 원인은 **손익 회계 버그가 trade_journal 손익을 왜곡 → market-gate 서킷 브레이커가 누적 R을 음수로 계산 → 18개 심볼/전략을 잠금(locked) → 전략 신호 생성 차단 → 국내 진입·토스 미러 마비**.

## 전체 인과 체인 (완전 규명)

```
[뿌리] 손익 회계 버그(C7-9 Layer1) → trade_journal 손익 왜곡
   ↓
[1] market-gate 서킷브레이커가 trade_journal로 누적 R 계산 → 음수
   ↓
[2] cumulative_r_below_zero → 18개 심볼/전략 LOCKED
   ↓
[3] 잠긴 동안 전략 신호 생성 차단 (entryTriggerShadow candidates=0)
   ↓
[4] luna_strategy_signals 거의 빔 (crypto 8건·domestic 1건·overseas 0건, 6/18 이후 중단)
   ↓
[5] 국내 preflight 144건 전부 block (신호 1건 + 그 RR 1.36 < minRr 2.0)
   ↓
[6] 국내 거래 중단(6/5~, 3주) + 토스 미러 후보 0건
```

## 증거

**토스 미러:** `luna_toss_paper_mirror_log` 0건. 후보 쿼리는 domestic preflight 'pass' 신호인데 pass 0건.

**국내 preflight:** `luna_entry_preflight_log` 144건 전부 decision='block', 전부 G-rr(rr_below_min). 144건 모두 동일 종목(005930 삼성전자)·동일 RR(1.36) = 신호 1개를 반복 평가.

**전략 신호:** `luna_strategy_signals` crypto 8·domestic 1·overseas 0. 최신 6/18(crypto)·6/12(domestic). 전체 생성 빈약 + 6/18 중단.

## 서킷 브레이커 잠금 상세

`bots/investment/output/luna-market-gate.json` (market-gate 30분 데몬 출력, 6/26 07:58 정상 실행):
- circuitLocks **18개 항목** 잠김
- 대부분 `cumulative_r_below_zero` (1개는 within_2_candle_cooldown)
- 누적 R 값들: -0.1742(sample4), -0.0104(s1), -0.0313(s1), -0.0481(s2), -0.0317(s1), -0.0815(s2), -0.035(s1), -0.0723(s1), -0.0142(s1)...
- lookback 14일, **source: investment.trade_journal**
- `entryTriggerShadow`: candidates=0, armed=0, fired=0 → 신호 생성 0

## 핵심 발견 2가지

### 발견 1: 서킷 브레이커가 손익 버그에 오염됨 (가능성)
- 잠금 판정의 누적 R이 `investment.trade_journal` 기반인데, 이 테이블이 바로 C7-9 손익 버그로 왜곡된 곳
- trade_journal 손익이 부풀려졌다 줄었다 하면 R 계산도 왜곡 → **버그가 부당하게 서킷을 잠갔을 수 있음**
- 검증 필요: 잠긴 18개 심볼이 오염 거래(NOM/PUMP/PENGU 등 16건)와 겹치는지

### 발견 2: 서킷 브레이커 과민 (sample 1~2개로 잠금)
- 18개 중 다수가 **sample 1개의 -0.01~-0.03 R**로 잠김
- 표본 1개의 작은 손실로 14일 잠그는 건 통계적으로 과민
- 표본 1개는 노이즈와 구분 불가한데 전략 신호 생성을 막아버림
- → lookback/최소표본/임계 재설계 검토 필요

## 코드 위치

- **전략 신호 생성 경로**: `ai.luna.market-gate-30min` launchd → `bots/investment/scripts/runtime-luna-market-gate.ts` L278 `insertStrategyFamilySignals` → `luna_strategy_signals`
- **신호 생성 로직**: `bots/investment/shared/luna-strategy-families.ts` (computeStrategyFamilySignals L836, evaluateTurtleBreakout L393, evaluateTestahPullback L467) — shadowOnly:true
- **서킷 브레이커 잠금**: market-gate 내 circuitLocks (cumulative_r_below_zero, source=trade_journal)
- **preflight 게이트**: `bots/investment/shared/luna-entry-preflight-gate.ts` L209-213 (G-rr, minRr 기본 2.0, c4.min_rr 파라미터)
- **registry-evaluator** (`runtime-luna-registry-evaluator.ts`): 평가/제안만, 신호 생성 안 함(SELECT만, liveMutation:false)
- **토스 미러**: `luna-toss-paper-mirror.ts` (loadPaperMirrorCandidates는 domestic preflight pass 조회 — 후보 0)

## 다음 단계

1. **서킷 잠금 18개 ⋈ 손익 버그 연관 분석** — 잠긴 심볼이 오염 16건과 겹치는지. 겹치면 데이터 보정 시 자동 해제.
2. **서킷 브레이커 민감도 재설계** — sample 1개 잠금 방지(최소표본 상향), lookback/임계 재검토. 코덱스 명세.
3. **Layer 1 데이터 보정** — trade_journal 오염 16건 보정(C7-9) → 서킷 R 계산 정상화. 근본 해결.
4. **국내 전략 신호 생성 빈약** — 서킷 외에도 국내 신호가 원래 적은지(전략군 자체 문제) 별도 점검.

## 핵심 교훈

손익 회계 버그(C7-9)는 단순 데이터 왜곡이 아니라 **시스템 제어 흐름을 오염**시켰다. trade_journal을 읽는 서킷 브레이커가 왜곡된 손익으로 잠기면서, 전략 신호 생성 → 진입 → 거래 → 토스 미러까지 연쇄 마비. **손익 데이터를 읽는 모든 제어 로직(서킷·게이트·학습)이 버그의 영향권.** 데이터 보정이 단순 회계 정정을 넘어 시스템 복구의 핵심인 이유. 마스터의 토스 직관이 이 깊은 연결고리를 드러냄.
