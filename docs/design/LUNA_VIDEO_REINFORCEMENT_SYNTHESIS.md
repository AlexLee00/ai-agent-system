# 루나 영상 분석 종합 + 개선 로드맵 (1차 13편 + 2차 6편 통합)

> 작성: 메티 · 2026-06-26 · 상태: 종합 설계 + Phase 1 명세완료(코덱스 구현중, C7-13)
> 목적: 1차 배치(B-01~B-20, 13편)와 2차 배치(V1~V6, 39항목, 6편)를 통합 → 이번 개선(C7-9 손익버그·C7-10 서킷마비)에 반영할 단계적 로드맵 도출
> 소스: `docs/design/archive/luna-precursor/LUNA_VIDEO_REINFORCEMENT.md`(1차) + `docs/design/LUNA_VIDEO_REINFORCEMENT_2026-06.md`(2차)
> 진단 연계: `docs/session/LUNA_DOMESTIC_PARALYSIS_ROOTCAUSE_2026-06-26.md`(C7-10) + `docs/session/LUNA_SIGNAL_REVERSE_MECHANISM_2026-06-26.md`

## 핵심 통찰 — 19편이 우리 발견을 입증

19편의 트레이딩 영상이 일관되게 강조한 원칙이, 우리가 토스→국내마비 추적으로 발견한 **손익버그→서킷오염→신호마비(C7-9/C7-10)** 문제의 이론적 근거를 정확히 제공함. 즉 **우리 게이트 철학은 옳았고, 진짜 문제는 서킷 과민·신호생성 마비**임이 외부 검증됨.

19편 공통 메시지 5가지:
1. **RR 우선** (V1-A·V3-A·V5-E + B-20): 손익비 1:2~3 이상 — 우리 G-rr(RR 2.0) 방향 옳음
2. **Expectancy = 엣지** (V1-A·V4-A + B-05): 승률×평균이익−패율×평균손실 — 손익버그가 이걸 오염
3. **충분한 표본 + 노이즈 제거** (V1-C·V4-C·V5-F + B-12 stability filter): 서킷 sample-1 과민이 핵심 위반
4. **추세의 끝 = signal_reverse** (V5-A + B-20): 우리 최고 청산(88% 승률)의 철학
5. **confluence 다중신호** (V2-E·V3-D·V6-B + B-10/B-12): fuseSignals 일관

## 통합 주제 클러스터 (1차 B + 2차 V 합본)

### 클러스터 A — 리스크/서킷 (C7-10 직결, 최우선)
- B-13 하드코딩 회로차단기(veto, drawdown 임계) / B-12 regime stability filter(≥3 bar, 플리커 방어)
- V1-B·V4-D 드로다운 보호 / V1-C 충분한 표본 / V4-C 의도적 step-out vs 노이즈 / V5-F 이중평균 노이즈제거 / V3-C 고확률 선별
- **종합**: 서킷이 sample-1 노이즈에 과민 잠금(C7-10). "의도적 차단(매크로 이벤트)=유지, 노이즈 차단(sample-1)=제거" + 최소표본 상향 + 평활화. 단 B-13 drawdown veto(되돌릴 수 없는 손실)는 유지.

### 클러스터 B — 진입/청산 신호 (signal_reverse + 진입 RR)
- V5-A 추세의 끝(signal_reverse 철학) / B-20 트레일링스톱·래더 / V5-E 부분익절(scale-out)
- V1-A·V4-A expectancy / V3-A 고RR / V2-D retest 진입(RR 개선) / V2-E·V3-D·V6-B confluence
- V2-B 스파이크속도·V2-C 3터치·V3-E wick크기 (정량 신호) / B-11 P(bull)−P(bear) 차등사이징
- **종합**: KIS signal_reverse 이식(명세 완료)에 V5-A 철학 + scale-out(V5-E/B-20). 진입은 confluence(V2-E/V3-D)+retest(V2-D)로 RR 개선 → C7-10 국내 G-rr 통과율 보조.

### 클러스터 C — 검증/백테스트
- B-18 검증3종(RST·MonteCarlo·멀티기간OOS) / B-16 벤치마크·스트레스·캘리브레이션
- V4-B recency bias(최근 1-2년)
- **종합**: PSR 게이트(C7-4)에 recency 가중 + B-18 다층검증. 손익 데이터 보정 후 PSR AUC 재계산 시 적용.

### 클러스터 D — 레짐 모델
- B-10 Markov 전이행렬 / B-12 레짐 정밀화(개수 자동선택·forward-only) / V5-D 5단계 흐름분류 / V6-E 세션/킬존
- **종합**: 레짐 신호를 서킷·진입에 결합. B-10/B-12가 코어, V5-D/V6-E 보조.

### 클러스터 E — 정량 지표 추가
- V6-D Volume Profile/POC / V2-B 스파이크속도 / V5-B 하이킨아시 / B-19 수급흐름(DART)
- **종합**: classifyVsaBar/진입에 정량 지표 보강. POC(지지/저항)+스파이크속도+수급. 선택적.

### 클러스터 F — 개발/운영 인프라
- V6-A Claude Code+MCP 도구제작(=우리 코덱스 검증) / V6-F 통합알림 / V6-G one-shot 프롬프트
- B-01 ADR / B-06 단일변수 실험 / B-05 스코어러 / B-08 비용최적화 / B-17 self-evolving 스킬
- **종합**: 우리 코덱스/refactor-cycle 방식이 베스트프랙티스임 확인. V6-F 통합알림(노이즈↓)+B-06 단일변수 규율 적용.

---

# 단계적 개선 로드맵 (우리 시스템 반영)

원칙: ① 기존 인프라 최대 재사용(신규 최소) ② PROTECTED launchd(crypto LIVE 무중단)·스카 실매출 무중단 ③ 3역할(메티 설계→코덱스 구현→마스터 승인) ④ shadow mode 우선 후 enable ⑤ 한 번에 한 변수(B-06).

## Phase 0 — 데이터 보정 (모든 것의 선결, CRITICAL)
> 손익버그가 서킷·게이트·학습을 오염시키므로, 데이터 보정 없이는 어떤 개선도 오염된 토대 위에 쌓임.
1. **Layer 1 데이터 보정** (코덱스/마스터): trade_journal 오염 16건 보정 → 서킷 누적 R 정상화. 이미 재발방지는 SHIPPED(172d522f7), 백필만 남음.
2. **서킷 잠금 18개 ⋈ 오염 16건 연관분석** (메티 read-only): 부당 잠금 식별 → 보정 시 자동 해제 예상 검증.
3. **검증**: 보정 후 market-gate 재실행 → circuitLocks 감소 + 국내 신호 생성 재개 확인.
- 산출: 국내 트레이딩 마비 해소의 직접 트리거.

## Phase 1 — 서킷 브레이커 재설계 (클러스터 A, C7-10·C7-13 핵심) — ✅ 명세 완료, 코덱스 구현 중
> 근거: V1-C(충분한 표본)·V4-C(노이즈 vs 의도적)·V5-F(평활화). 프로세스+데이터+영상 3분석 종합 (C7-13).
> 명세: docs/codex/SPEC_CIRCUIT_REDESIGN_2026-06-26.md (코덱스 구현 중)

**코드 결함 규명** (`luna-loss-circuit.ts` buildLowProfitLocks): `if (rValues.length === 0) continue`로 표본 0개만 거르고 **sample 1개여도 cumulative_r<0이면 잠금**(최소표본 부재). 단순 합산(통계 유의성 무시), 임계 정확히 0(노이즈 미구분). **불일치 증거**: 같은 파일 buildStoplossGuardLocks는 `if (rows.length < limit) continue`로 tradeLimit(4) 요구하나 low_profit만 표본 기준 없음.

**시뮤레이션** (현재 17개 low_profit 잠금에 재설계안 대입):

| 시나리오 | 잠금 | 해제 |
|---|---|---|
| A. 현재(min_sample 없음) | 17 | 0 |
| **B. min_sample=3** | **1** | **16** |
| C. min_sample=5 | 0 | 17(과함) |

→ **min_sample=3 확정**: 노이즈성 16개(sample 1~2) 해제 + 진짜위험 MEGA(sample=4·cumR=-0.17) 유지. C(=5)는 MEGA까지 해제되어 과함.

**해법** (명세 완료): buildLowProfitLocks에 `if (rValues.length < 3) continue` 1줄 + 파라미터 c4.low_profit_min_sample=3. 기존 stoploss_guard와 동일 패턴(일관성). shadowOnly 유지.

**향후 확장**(Phase 1엔 미포함, 후속): 평활화(B-12 stability filter 연속 N구간), drawdown veto(V4-C/B-13 이 파일엔 없음—별도 확인).

- **검증 기준**: market-gate 재실행 → circuitLocks low_profit 17→1 + luna_strategy_signals 증가(국내/crypto 신호 재개).

## Phase 2 — KIS signal_reverse 이식 + 청산 강화 (클러스터 B)
> 근거: V5-A(추세의 끝=signal_reverse 철학)·V5-E/B-20(scale-out·트레일링). 명세 이미 완료.
1. **signal_reverse 이식 Phase 1** (코덱스, 명세 `docs/codex/SPEC_KIS_SIGNAL_REVERSE_EXIT_2026-06-26.md`): KIS 능동청산 모니터(shadow) + 시간초과 손실떨이 안전망 강등.
2. **부분익절(scale-out) 추가** (V5-E/B-20): 손익비 도달 시 절반 익절 + 신호변경 시 전량. 향후 청산 4종 중 우선.
3. **트레일링 스톱** (B-20 래칫): 이익 잠금 플로어. signal_reverse와 결합.
- 산출: 국내/해외 청산이 시간초과 손실떨이(11% 승률)에서 능동 청산으로. 매도가 손익을 결정.

## Phase 3 — 진입 RR 개선 (클러스터 B 진입측, C7-10 보조)
> 근거: V2-D(retest 진입 RR↑)·V2-E/V3-D(confluence)·V2-B/V2-C(정량 신호).
1. **retest 진입 옵션** (V2-D): 돌파 직후 대신 retest 대기 → RR 개선 → 국내 G-rr(RR 2.0) 통과율↑. C7-10의 신호측 보조 해법.
2. **confluence 강화** (V2-E/V3-D): 진입 유효성에 "복수 신호 동시발생" 기준. fuseSignals 확장.
3. **정량 신호 추가** (V2-B 스파이크속도·V2-C 3터치): classifyVsaBar 보강.
- 산출: 신호가 RR 기준을 더 잘 충족 → 선별 후에도 충분한 신호 생존(V3-C와 균형).

## Phase 4 — 검증/레짐/지표 보강 (클러스터 C·D·E)
> 근거: V4-B(recency)·B-18(검증3종)·B-10/B-12(레짐)·V6-D(POC).
1. **PSR recency 가중** (V4-B): 데이터 보정 후 PSR AUC 재계산 시 최근 1-2년 가중.
2. **검증 3종** (B-18): RST·MonteCarlo·멀티기간 OOS를 백테스트 게이트에 추가.
3. **레짐 정밀화** (B-10/B-12): Markov 전이행렬 + stability filter를 서킷/진입에 결합.
4. **정량 지표** (V6-D POC·B-19 수급): 선택적 보강.
- 산출: 검증 다층화 + 레짐 신호 + 지표 정밀도.

## Phase 5 — 운영 인프라 (클러스터 F)
> 근거: V6-F(통합알림)·B-06(단일변수)·B-01(ADR).
1. **통합 알림** (V6-F): 여러 신호 1개 알림(노이즈↓). telegram-trade-alerts.ts 적용.
2. **단일변수 실험 규율** (B-06): 전략 진화 시 한 번에 한 변수 + 베이스라인 승격. 다윈/시그마 정합.
3. **ADR 결정 기록** (B-01): 서킷/청산 정책 변경을 ADR로.
- 산출: 운영 규율 + 노이즈 감소.

---

# 우선순위 요약 (마스터 결정용)

| Phase | 주제 | 담당 | 시급성 | 의존성 |
|---|---|---|---|---|
| **0** | 데이터 보정 | 코덱스/마스터+메티 | **CRITICAL** | 없음(선결) |
| **1** | 서킷 재설계 (min_sample=3) | ✅명세→코덱스 구현중 | **최우선** | 독립 가능(C7-12) |
| **2** | signal_reverse 이식 | 코덱스(명세 완료) | 높음 | 독립 가능 |
| **3** | 진입 RR 개선 | 메티 명세→코덱스 | 중간 | Phase 0·1 |
| **4** | 검증/레짐/지표 | 메티 명세→코덱스 | 중간 | Phase 0 |
| **5** | 운영 인프라 | 코덱스 | 낮음 | 독립 |

**권장 순서** (C7-12 진단수정 반영): **Phase 1(서킷, 마비 해소 주 레버) + Phase 2(signal_reverse) 병행** → Phase 0(데이터보정, 병행) → Phase 3 → Phase 4 → Phase 5.

**핵심 수정**: 당초 Phase 0(데이터보정)을 선결로 봤으나, **C7-12 연관분석이 이를 반증** — 서킷 잠금 17개 중 16개(94%)가 오염 무관하게 과민 잠금. 따라서 **Phase 1(서킷 재설계, min_sample=3)이 국내/crypto 마비 해소의 주 레버**(16개 해제), C7-13 시뮤레이션으로 검증됨. Phase 0(데이터보정)은 expectancy/PSR 정확성 + MEGA + 가짜수익 제거를 위해 **병행**(선결 아님). signal_reverse(Phase 2)로 매도 개선. **양대 축: 서킷 재설계(마비 해소) + signal_reverse(매도 개선)**, 데이터보정은 정확성 보완으로 병행.
