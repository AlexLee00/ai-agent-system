# 루나 최적 재설계 설계서 (Phase 3)

> 작성: 메티 · 2026-06-12 (최신 2026-06-18 통합) · 상태: **v1.4** — C18 토스·ET 트랙 본문 통합 — v1.0 확정 + 보강 3건(C4 손실빈도 서킷·C3 WB 후보·G2 시퀀스, 마스터 승인 반영). 확정 6건=§7. 회의실=MEETING_ROOM_DESIGN v0.6. 구현=LUNA_OPTIMAL_REDESIGN_TRACKER
> 입력: LUNA_LOGIC_REANALYSIS.md(Phase 1 진단·신규 12영상 6원칙·B-01~20 재배치·M-1~M-11·외부자료 E-1~3/QuantaAlpha 등·루틴 비전)
> 원칙: 비용 무시·최적 성능(마스터 지시). 무중단(PROTECTED launchd·크립토 LIVE·스카 실매출). 3시장(국내·해외·crypto) 공통 + 시장별 변형.

## 0. 목표 상태 (북극성 = 마스터 루틴 비전)
**거래 루틴 7단계 완전자율 루프**: ①리소스 분석 → ②종목 선정 → ③매매 전략 수립 → ④진입 → ⑤청산 → ⑥매매 데이터 수립 → ⑦피드백 루프 학습 → (①로 순환)
**영향 변수 4종**(루프 전체에 주입): 추세(상승·하락·횡보) · 회의 결과 · 워치리스트 · 거래 리밋
**완전자율**: 모든 설정·지수·계수가 분석에 따라 **동적 변경**(정적 매직넘버 0개가 이상). 단, 자율의 전제 = **검증 게이트**(검증 통과분만 자기 변경) + 회로차단기(B-13) + 마스터 게이팅(LIVE 영향 변경).

## 0-b. 모든 액션의 루프화 원칙 [마스터 보강 — §0 확장]
> **루나팀의 모든 액션은 [실행 → 측정 → 평가 → 제안/조정 → 실행] 루프를 가진다. 끝나는 액션은 없다.**

| 액션 | 측정 | 평가 | 제안/조정(자동) | 마스터 게이트 |
|---|---|---|---|---|
| 거래(G0~G7) | 거래 저널(C8) | E·R:R·레짐별 성과 | 파라미터 스토어 갱신(검증 통과분) | 구조 변경만 |
| shadow 실험 | 비교 로그 | 승격 기준(C15) | 승격/중단/정체 제안서 | 승격 승인 |
| 파라미터 | 변경 이력+성과 | 변경 전후 비교 | 롤백/유지 제안 | 임계 초과 변경 |
| 전략군 | 군별 롤링 E | 부패 감지(E 추세↓) | 비활성화/재튜닝 제안 | 군 추가·제거 |
| 에이전트 | ablation(C13) | 기여도 | 제거/병합/과업 변경 제안 | 재구성 승인 |
| 회의 | 결정 ADR | 결정 추적(이행·결과) | 미이행·역효과 결정 재상정 | 회의 자체 |
| 데이터 소스 | 소스별 신호 기여 | IC·지연·결측 | 추가/교체 제안(M-11) | 신규 소스 |
- 마스터 위치 = **루프 내부가 아니라 게이트(결정점)**. 제안이 마스터에게 오고, 데이터 수집·분석·요약은 전부 시스템 몫(C15).

## 1. 핵심 아키텍처 전환 — 한 문장
> **"LLM이 최종 결정하는 휴리스틱 적층"을 "검증된 결정론 스코어 코어 + LLM 리뷰어"로 전환한다.**
- 현재(Phase 1 진단): 매직넘버 편재·편향 적층·LLM 최종결정(백테스트 불가)·조건부 enrichment·advisory 일변·레짐=최약 입력.
- 근거: V-B/V-D(LLM 코어 금지, 이중 확인)·E-3(에이전트 적층=노이즈 가능)·전 영상 공통(결정론 룰+종가확인+구조손절).
- LLM의 새 역할(결정권 박탈, 3역할): **리뷰어**(thesis 구멍·베어케이스, grill/B-03 합류) · **보조 점수**(결정론 필터 통과 후보에 0-10, 가중 블렌드 — 위치가 핵심: 필터 後) · **연구**(공시·뉴스 인제스트, 워치리스트 후보 발굴).

## 2. 신규 결정 스택 (파이프라인 — 7단계 루틴의 ②~⑤ 구현)
```
[G0] 시장 배치 게이트(Market Deployment Gate)     ← C1, 매크로 합성 0-100
  └ full(>70) / reduced(40-70, 사이징 60%) / halt(<40, 신규 진입 중단·EXIT만)
[G1] 레짐 분류(Regime Engine)                      ← C2, P(bull)/P(bear)/P(range) 확률
[G2] 전략군 라우팅(Strategy Family Router)         ← C3, 레짐→활성 전략군 스위칭
  └ 상승추세: 터틀형 추세돌파 + 테스타형 눌림목
  └ 하락추세: 방어(현금↑·EXIT 우선) + crypto 한정 숏/딥래더(V-E)
  └ 횡보: 레인지(ORB/Sneaky 변형) 또는 관망(기본값=관망)
[G3] 종목 스캐너(2단, V-C 구조)                    ← discovery(A: 넓게) → 전략별 결정론 entry 룰(B: 좁게)
  └ 각 전략군의 명시 룰: 종가 마감 확인 + 리테스트(fakeout 필터) + 구조 손절 위치 산출
[G4] 사전 게이트(Pre-Trade Gates) — 진입 부정이 1급 결정
  └ R:R ≥ 2 (V-H) · E > 0(비용 차감, V-A) · 횡보/애매 차단(VPF 개념) · 유동성 최소(죽은 종목 회피, V-J)
[G5] 사이징(Position Sizer)
  └ 고정% 리스크(0.25~2%, 스톱 거리 역산) × 레짐 멀티(동적) × fractional Kelly(드로다운 축소) × G0 배치율
[G6] LLM 리뷰어(감점/플래그만, 거부권 없음 — 회로차단기와 구분)
[G7] 집행(Execution): 트리거(래더/리테스트 대기) → 주문 → 청산(구조 손절 + 트레일링 래칫)
```
- 전 단계 **결정론·백테스트 가능**(G6 제외 — G6는 기록·감점만이라 백테스트에서 제외 가능).
- 모든 임계·멀티 = **파라미터 스토어**(코드 하드코딩 금지) + 검증 파이프라인(C7)으로만 갱신 = 동적 제어의 실체.

## 3. 컴포넌트 설계 (기존 자산 → 재사용/승격/신설)
### C1. 시장 배치 게이트 [신설, V-B 모델]
- 시장별 6신호 → 각 0-100 → 가중 합성: **미국**=VIX 레벨·VIX 기간구조·breadth(200MA 위 %)·HY credit spread·put-call·factor crowding / **한국**=KOSPI 변동성(VKOSPI)·breadth·외국인/기관 수급(B-19)·환율 모멘텀·미국 게이트 전이 / **crypto**=BTC 변동성·BTC 도미넌스·펀딩레이트(기보유)·온체인(oracle 기보유)·미국 게이트 전이.
- 출력: deployment ∈ {full, reduced(60%), halt}. 기존 `capitalGate`(자본 상태)와 **직교** — 자본=낼 수 있는가, 배치=내야 하는가.
- 재사용: marketRegime 데이터 피드·oracle 온체인·sentinel. 신설: 합성 스코어러+이력 로깅(검증 가능).

### C2. 레짐 엔진 [승격: HMM shadow→core + 전이행렬 B-10]
- 출력 = **P(bull)/P(bear)/P(range) 확률 벡터**(라벨이 아닌 확률, B-11) + 전이 경보(레짐 전환 임박 = M-3 수시회의 트리거).
- 현 카운트 휴리스틱(market-regime.ts)은 **폴백**으로 강등. REGIME_GUIDES 정적 멀티 → 파라미터 스토어(검증 갱신).
- 검증: 레짐 분류 자체를 백테스트(레짐별 전략군 성과로 평가) + 캘리브레이션(Brier).

### C3. 전략군 룰셋 [신설 — Phase 2 확보 룰의 1급 승격]
| 전략군 | 진입(결정론) | 손절 | 청산 | 활성 레짐 |
|---|---|---|---|---|
| trend_breakout(터틀) | 20봉 최고 돌파 **종가 마감** | 진입−2×ATR(20) | 10봉 최저 이탈 종가 / 트레일 전환 | bull(롱)·bear(crypto 숏) |
| pullback(테스타) | 정배열(5/25/75)+5선 눌림→**재돌파 종가** (75선 붕괴 무효) | 직전 저점 직하 | 3:1 고정 or 분할+추적손절 | bull |
| range(ORB/Sneaky) | 레인지 레벨(전일 고저/오프닝 레인지) 돌파+**리테스트 확인** | 레인지 중간값/빅바이어 직하 | 반대편 레인지 라인 | range(고유동성만) |
| defensive | 신규 진입 없음·EXIT 우선·현금↑ | — | 기존 포지션 트레일 타이트닝 | bear·halt |
- 공통: 종가 확인(개미털기 회피)·리테스트(fakeout, V-I 70%vs33%)·구조 손절·R:R 사전 계산. 파라미터(20/10/5/25/75/ATR배수)는 **stable-range 선정**(E-1: 최적화 일반화 약함→넓은 양호 구간의 중앙값 고정) 후 파라미터 스토어.
- 재사용: wyckoff-phase-detector(수요존≈accumulation)·vsa·dynamic-trail-engine(트레일)·entry-trigger-engine(리테스트/래더 트리거 확장).
- **[ET 트랙 2026-06-18 마스터 지시] entry-trigger-engine 연결 + 발화 레이어**: 현재 30분 러너는 전략군 **기본 룰**(터틀 돌파·테스타 눌림)만 구현, 정교 트리거(리테스트 확인·래더 분할매수·MTF 동의)는 entry-trigger-engine 재사용 예정이나 미연결(worker만 5/4 retired·**엔진 보존**). 발화 레이어("신호→발화")도 재설계 스택 미연결. **shadow 안전**: `shouldAllowLiveEntryFire()`는 `liveFireEnabled=false`면 무조건 false → 실발화 0(내장 게이팅 재사용). 발화 레이어=**would-fire 기록**(주문 안 함·placed:false, 토스 paper-mirror 패턴). 분할: **ET-A**(전략군 신호→trigger candidate 어댑터 + 통째 shadow 연결·liveFireEnabled=false 강제·fire 0 단언) → **ET-B**(리테스트/래더 관찰 후 신세대 정리·would-fire) → **ET-C**(C16 expected-fire 워치독+debrief 미발화 편차+수시회의⑦) → **ET-D**(C15 등록·전략군 룰 재평가 vs 기본). 접근=통째 연결 관찰→유용 로직 추출(처음부터 추출 시 무엇이 유용한지 모른 채 재구현 위험).
- **[v1.1] 레인지 룰셋 후보 추가**(V-N): WB 더블 볼린저 — 변곡(양 밴드 터치+꼬리+밴드 안 마감=반전) vs 돌파(양 밴드+**앞 매물대 동시 돌파**+종가 마감) 2분류, 매물대 이중 컨펌으로 fakeout 차단 — P1-4에서 Sneaky/ORB와 **비교 백테스트 후 채택**(자가 주장 수치 불신, 자체 검증).
- **[v1.1] 전략군 시퀀스 노트(G2)**: 추세 진입은 **돌파(터틀) 직후 또는 첫 눌림(테스타)만** — 추세 후반 늦은 눌림 진입 차단(V-N "추세는 초반에"). 라우팅에 추세 연령(돌파 후 경과 캔들) 파라미터.


> **[정합성 노트 2026-06-19 — 메티 정밀 분석]** ① **turtle 활성 레짐 정렬 필요**: 본 표는 turtle=bull·bear(crypto 숏)이나 현 코드는 bull·volatile(숏 미구현→bear를 volatile로 대체 추정). 레짐 확대 shadow가 turtle에 **sideways 추가**(bull·volatile·sideways) 관찰 중 — C3 추세 추종 방향(bull·bear)과 결이 다름. 실제 확대 결정 시 **C8 outcome 데이터로 "sideways turtle 수익성" 검증 후 C3 재정렬**(shadow라 현 영향 0). ② **패턴 완화 stable-range 의무**: 패턴 완화 shadow의 완화안(maFilter 200→100·entryLookback 20→10·pullbackWindow 5→10·maSlow 75→60)은 탐색용 임의값 — 실제 적용 시 **stable-range 백테스트(C7·넓은 양호 구간 중앙값)** 통과 필수.

### C4. 사전 게이트 [신설 + 기존 강화]
- **R:R 게이트**: 진입가·구조손절·목표(전략군별 정의)로 R:R 계산 → <2 거부. **E 게이트**: 전략군×레짐별 롤링 E(비용 차감, 최소 30거래 — 미달 시 통과시키되 사이징 축소) ≤0 거부. **횡보/애매 차단**: 레인지 전략 외에는 range 레짐에서 진입 거부 + 거래량 압력 애매(저변동·저거래) 차단. **유동성 최소**: 일평균 거래대금 하한(시장별).
- 기존 약신호 게이트(0.22/0.32 하드코딩) → 이 4게이트로 대체. reflexion/blacklist 게이트는 유지.
- **[v1.1] 손실 빈도 서킷 3종**(freqtrade protections 검증 패턴, E-4): ①**StoplossGuard형** — lookback L분 내 손절·강제청산 N회 → T분 진입 잠금(**전역/심볼/사이드 3레벨**, 초기값 L=1440·N=4·T=당일) ②**심볼 쿨다운** — 청산 직후 동일 심볼 재진입 금지(초기 2캔들) ③**저수익 심볼 잠금** — 기간 내 누적 손익 음수 심볼 잠금. 기존 회로차단기(B-13·WS-I)와 통합, 파라미터=스토어(tier=approve). V-M 3계층 서킷(거래당 1%·일일 −5%·빈도)의 일반화. **[실측] `perception-first.ts` `consecutive_loss_cooldown:3` 기존재 — 신설 아닌 일반화·승격**(연속→기간 내 빈도, 전역/심볼/사이드 3레벨 확장).

### C5. 스코어 융합 재정의 [대체: fuseSignals/blendedConfidence/predictiveScore]
- 현행 임의 가중(0.7/0.3·0.55/0.45·analyst weights) 폐지 → **검증된 소수 입력의 단일 스코어**: 알파팩터 IC 가중 합성(LG-01/QuantaAlpha 산출) + 레짐 확률(C2) + 전략군 신호 강도(C3 룰 충족도) + 캘리브레이션 보정(예측확률→실현빈도 매핑).
- 분석가(aria/oracle/sentinel/sophia/hermes) 신호는 **알파팩터 후보·게이트 입력으로 강등**(직접 결정 가중 폐지) — M-9 ablation으로 기여도 검증 후 재배치.

### C6. LLM 계층 [재정의 — 결정권 박탈]
- 리뷰어: G6에서 후보별 베어케이스·누락 리스크 산출 → 감점(상한 캡)·플래그(회의 안건). 프롬프트=**계산된 지표 주입**(E-3 과업 명세, raw 덤프 금지).
- 보조 점수: 재무·공시 인제스트 → 0-10 → 결정론 스코어와 가중 블렌드(가중치도 파라미터 스토어).
- 연구: 뉴스→심볼 매핑(기보유)·공시 분석(disclosure-event 기보유)·워치리스트 후보 발굴(M-6).
- 토론(제우스/아테나)은 **회의실·리뷰어 입력으로 이동**(심볼별 인라인 토론 2R는 비용 대비 노이즈 — E-3 ablation 대상).

### C7. 검증 파이프라인 [통합 — 기존 자산 ON + 신설]
- **point-in-time 유니버스**(V-D 생존편향): 백테스트 시점별 구성종목 재구성 — 신설(최우선 점검: 현 discovery universe가 현재 시점 기준인지 실측 필요).
- **1-bar shift 룩어헤드 점검**(E-2): backtest-vectorbt.py 감사.
- **permutation 2종**(E-1): IS(후보 사전 차단, p<1%)·WF(최종, 1년 p≤5%) — backtest-vectorbt.py 확장.
- 기존 ON 승격: robust selection(`LUNA_BT_ROBUST_SELECTION_ENABLED=true`)·DSR/PBO 게이트(shadow→enforce, 핵심 경로만)·CPCV(purge+embargo, 기존 갭 — 신설).
- **OOS 보존 규율**(E-1): OOS 사용 횟수 기록·시도 카운터(스누핑 가드)·최종 검증만 OOS.

### C8. 피드백 루프 [M-1 — 루틴 ⑥⑦]
- 매매 데이터 수립: 거래마다 전략군·레짐·게이트 스코어·R:R 계획 vs 실현·E 기여 기록(trade-journal 확장, 머신리더블).
- 학습 규율: **최소 30거래/전략군×레짐 단위**(소표본 금지 — reviewHint closedTrades≥3 폐지)·E/R:R 단위로만 평가(승률 단독 금지)·갬블러 오류 차단(연속 손실에 사이징 증가 금지).
- 반영 경로: 통계 → 가설 → **C7 검증 통과 시에만** 파라미터 스토어 갱신(자동) 또는 회의 안건(구조 변경=마스터 게이팅). win-pattern-extractor·hermes-learn·Sigma RAG 재사용.


> **C8 구현 현황 (2026-06-19 실가동)**: 전략군 shadow 신호 결과 추적 완성. `luna_strategy_signal_outcomes`(append-only·UNIQUE signal_id·shadow_only) + 판정 로직(entry 신호→OHLCV→target 먼저=win·stop 먼저=loss·**동시 도달 시 stop 우선** 보수적·**룩어헤드 차단**=candle_ts 익일부터) + 전략군×레짐 E/R:R 집계(30거래 규율·소표본 provisional) + evaluator-daily 피기백(매일 06:20 자동 평가). 첫 실평가 005930=win(target_hit·+1.36R·+14.73%·5봉). shadow/advisory(실거래 0·파라미터 자동 갱신 금지·C7 통과 시에만 반영). **시스템 보강 철학**: 외부 바이럴(인스타 AI 트레이딩=디벙크 다수·조작/과적합) 대신, Dave Cliff 교훈(신기능보다 **측정·학습 능력**이 진짜 견고함)에 따라 검증된 피드백 루프를 우선 보강.

### C9. 포지션·자본 [M-5]
- 매도 체결 이벤트 → **capitalSnapshot 재평가 훅**(같은 사이클 내 buyable 재계산 → monitor_only 해제 가능).
- 일일 거래 리밋: 고정 15 → **동적**(기본 15 × 레짐 멀티 × 최근 E 부호 × G0 배치율, 상한 캡 유지). 회전 과다는 비용 모델(E 게이트)이 자연 억제.

### C10. 워치리스트 [M-6 — 통합 신설]
- 등록(마스터 수동 + LLM 연구 후보 + 전략군 근접 후보(룰 80% 충족)) → 전용 모니터링(가격·수급·공시·**진입조건 충족 알림**) → 회의 안건 자동 연동 → 충족 시 G3 스캐너 B로 합류. 기존 산재 개념(seed/tier/shadow_monitor) 흡수.

### C11. 회의실 [M-3 — v0.4 위에 증분]
- 기존: 버튼(ad-hoc)+정기(일일 전술 05:00 KST·주간 전략 일요 06:00). 추가: **이벤트 트리거 수시회의** — G0 halt 진입·레짐 전환 경보(C2)·회로차단기 발동·대형 공시(워치리스트/보유)·일일 손실 임계. 수시회의 출력=파라미터 긴급 조정 제안(검증 게이트 경유)+마스터 알림.
- 회의 결과 = 영향 변수(루틴 비전): 머신리더블 결정(ADR/B-01) → 파라미터 스토어·워치리스트·리밋에 주입.

### C12. 예측 엔진 [M-7 — 일원화] **[ALPHA 구현 완료 2026-06-13: shared/luna-alpha-factor-*·룩어헤드 3중 방어·shadow·evaluator 피기백 정례화·R5 승격/R6 회의실연결은 대기]**
- 산재(phase-a·predictive-gate·HMM) → 단일 스택: **알파팩터 IC(QuantaAlpha 패턴: 가설→심볼릭→코드→백테스트, 궤적 진화) → 레짐 확률(C2) → 캘리브레이션(Brier 추적, 예측→실현 매핑) → C7 검증 게이트**. LLM 직접 가격 예측 금지(V-B/V-D). 산출물이 C5 스코어의 입력.

### C13. 에이전트 재구성 [M-9 + E-3]
- **leave-one-out ablation**: 분석가별 제거 실험(shadow 백테스트) → 기여도 음수면 제거/병합. 잔존 에이전트=과업 명세화(계산된 지표 주입). 페르소나(AI Hedge Fund 참고)는 리뷰어 다양성 용도(bull/bear/리스크 페르소나).
- 모델 라우팅(M-8): Hub LLM_AUTO_ROUTING 활성화+과업별 성과 추적→자동 전환. RL(rl-policy-shadow)=사이징·트리거 미세조정 후보(결정론 코어 위 레이어, shadow 검증 후).

### C14. 오토 리서치·데이터 소스 [M-10·M-11]
- 오토 리서치: 주기적 자동 탐색(전략·기술·MCP/스킬) → 평가 보고서 → 회의 안건. QuantaAlpha 알파 마이닝 루프가 1호 구현. 다윈팀 패턴 재사용.
- 데이터 소스: 인벤토리 실측(yahoo·KIS·Binance·OpenDART·KRX·뉴스) → 갭(수급 상세·옵션·온체인 확장·대체 데이터) 우선순위.

### C15. 승격 제안 엔진 (Promotion Proposal Engine) [신설 — 마스터 보강 2026-06-12, 기존 hybrid-promotion-gate 일반화]
> 원칙: **마스터는 데이터를 뒤지지 않는다. 시스템이 분석해서 제안하고, 마스터는 결정만 한다.** 모든 shadow·실험·파라미터 변경은 이 엔진의 관리 대상.

**1) 승격 기준 사전 정의** — 모든 shadow 컴포넌트는 등록 시 기준을 함께 정의(기준 없는 shadow 금지):
- 최소 표본(예: 신호 30+/거래 30+/기간 2주+) · 우월성(가상 성과 Δ, 예: E +X% 또는 MDD −Y%p) · 통계 신뢰(permutation/p값 또는 DSR) · 무결성(오류율·지연 상한).

**2) 주기 평가 + 즉시 트리거**:
- 정기: 일일 회의(전술)에서 현황 1줄 요약, 주간 회의(전략)에서 전체 평가.
- 즉시: 기준 충족 도달 / 성과 악화(중단 기준) / 표본 정체(4주+ 미달) 시 회의 대기 없이 발화.

**3) 자동 제안 3종** (텔레그램 + 회의 안건 자동 등록, 머신리더블 ADR 초안 포함):
- ✅ **승격 제안서**: 근거 데이터 요약(표본·Δ·p)·리스크·롤백 계획(env 플래그)·권고 Stage. 마스터=승인/보류/거부 **원클릭 수준**.
- ⛔ **중단·재설계 제안서**: shadow가 LIVE 대비 열등 확정 시.
- ⏸️ **정체 보고**: 표본 부족 지속 → 실험 설계 변경 제안(기간 연장/기준 완화/폐기).

**4) 사후 검증 루프** (승격 = 끝이 아니라 새 루프 시작):
- 승격된 컴포넌트는 자동으로 **사후 모니터링 등록**(기대 성과 vs 실성과) → 미달 시 **자동 롤백 제안**(임계 초과 시 회로차단기 즉시 롤백 + 사후 보고).

**5) 재사용**: `luna-hybrid-promotion-gate`·`hybrid-promotion-review` A2A 스킬·rollback_scheduler(24h 자동롤백)·alert-publisher. 신설=컴포넌트 레지스트리(승격 기준·상태·이력 테이블)+제안서 생성기.

> **[구현 2026-06-19 — 메티/CODEX-1] 판정 6상태 정합 완료**: `proposalForRow`가 실제 criteria 스키마를 평가하도록 재설계 — **measurement_only**(승격 게이트 키 없음·metrics-only)·**accumulating**(sample/기간 미달)·**evidence_pending**(sample+기간 충족·성과검증 대기)·stalled·halt. **promotion_proposal은 성과 게이트(CODEX-2) 통과 후만 생성** → "기준 없는 shadow 금지·sample 단독 승격 금지" 준수. 판정상태는 평가 출력 JSON(assessmentSummary)에만 기록(DB `status`는 운영 5값 active/stalled/proposed/promoted/halted 전용·CHECK 제약, 휘발성 판정상태로 미오염). 신규 shadow 등록은 evaluator가 `seedLunaComponentRegistry` 멱등 자동 반영(등록 누락 방지). 44종 실분포: measurement_only 36·accumulating 7·evidence_pending 1(candidate-backtest-entry-gate, sample 1081). 상세: TRACKER「자동승격 레지스트리 정합」.

### C15-b. Shadow 전수 인벤토리 → 레지스트리 초기 등록 [실측 2026-06-12]
> 마스터 지시: 모든 shadow를 승격 엔진과 연결. 아래 표 = C15 레지스트리의 **초기 시드**(P1에서 테이블화). 기준은 초안 — 등록 시 확정.
> 🔑 발견: `posttrade`·`position-lifecycle`은 이미 **shadow → supervised_l4 → autonomous_l5** 3단계 모드 보유 → 이를 C15 **표준 승격 경로**로 채택(전 컴포넌트 통일). phase-a promotion gate(기가동)는 C15의 1호 인스턴스로 일반화.

| # | 컴포넌트 | 현재 모드(실측) | 다음 단계 | 승격 기준 핵심(초안) | 비고 |
|---|---|---|---|---|---|
| 1 | phase-a 예측(15min) | shadow(출력 6/10 갱신) | advisory→router bias | 예측 적중률·캘리브레이션 Brier, 표본 200+ | promotion-gate 기가동, C12 합류 |
| 2 | HMM 레짐 | shadow | **core 승격(C2)** | 레짐별 전략 성과 Δ, 휴리스틱 대비 우월 | 재설계 P1 핵심 |
| 3 | ML price predictor | env OFF/실험 | shadow 등록 | IC>0 안정, 룩어헤드 무결성(E-2) | C12 일원화 대상 |
| 4 | fundamental-quant | shadow(6/10) | LLM 보조점수 입력 | 종목 선별 기여(ablation) | C6 블렌드 |
| 5 | earnings-surprise | shadow(6/9) | 이벤트 트리거 입력 | 이벤트 후 수익 기여 | C11 수시회의·M-6 연동 |
| 6 | disclosure-event | shadow(6/10) | 워치리스트 알림 | 공시→가격 반응 적중 | M-6 |
| 7 | korean-factor + factor-model-shadow | shadow(6/9, watchlist_only tier) | C5 스코어 입력 | 팩터 IC, point-in-time 무결성 | LG-01·QuantaAlpha 합류 |
| 8 | rl-policy-shadow | shadow | 사이징·트리거 미세조정(L4) | 가상 E Δ+, MDD 비악화, 30거래+ | C13, 결정론 코어 위 레이어 |
| 9 | stat-arb-shadow | shadow | 독립 전략군 후보 | 페어 안정성·E>0, WF permutation p≤5% | C3 전략군 추가 후보(V-D 페어) |
| 10 | strategy-router phase-A influence | diagnostic(0) | shadow_bias(0.25)→active_bias(0.5) | bias 적용 시 라우팅 성과 Δ | 가중 자체가 승격 경로 내장 |
| 11 | intelligent-discovery | shadow | advisory→hard_gate | discovery 후보 적중률 | G3 합류 |
| 12 | dynamic-tpsl-shadow-judge | shadow | C3 청산 룰 보조 | 트레일 대비 개선 Δ | dynamic-trail과 비교 |
| 13 | entry-llm-shadow-judge | shadow | G6 리뷰어 합류 또는 폐기 | ablation 기여도 | E-3 원칙 적용 |
| 14 | position-lifecycle | shadow | supervised_l4→autonomous_l5 | 라이프사이클 액션 정확도 | 표준 경로 원형 |
| 15 | posttrade feedback | shadow | supervised_l4→autonomous_l5 | 피드백 반영 후 E 개선 | C8 합류 |
| 16 | candidate-backtest entry gate | MODE env(advisory) | enforce(핵심 경로) | DSR≥0.90·30거래(기존 env) | C7 |
| 17 | DSR/PBO gate | shadow/advisory | enforce | 게이트 차단 정확도(차단분 가상 성과<0) | C7 |
| 18 | robust backtest selection | **OFF** | ON | 합의 파라미터 OOS 우월(E-1 WF perm) | P0-② 즉시 |
| 19 | LLM_AUTO_ROUTING (Hub) | shadow 대기(Week2) | active | 과업별 모델 성과 추적 | M-8, Week2 합류 |
| 20 | shadow-mode 래핑(symbol_decision) | LIVE 병행 로깅 | **신규 스택 Stage A 기반** | — (비교 인프라 자체) | G0~G7 shadow의 골격 재사용 |
| 21 | vault-shadow(eval/adjustments) | shadow | 파라미터 스토어 입력 | 조정안 사후 검증 통과율 | 시그마 vault 연동(Week2) |
| 22 | meta-neural-reflexion | shadow | C8 학습 레이어 | reflexion 제안의 채택 후 성과 | 소표본 규율 적용 |
| 23 | MAPEK | env | 자율 루프 프레임 | — | 0-b 루프화와 정합성 검토 |
| 24 | regime-expansion-shadow-sim | shadow | advisory | sideways/volatile 확대 would-have·bear 제외·matched 무변경, 4주 | C2/C3·2026-06-19 실가동 |
| 25 | pattern-relaxation-shadow-sim | shadow | supervised_l4 | 완화 entry의 C8 outcome E 양수·30거래/전략군×레짐, 4주 | C3·2026-06-19 실가동 |
| 26 | signal-outcome-feedback | shadow | supervised_l4 | 전략군×레짐 30거래 후 E 양수 | C8·2026-06-19 실가동 |
| 27 | signal-outcome-eval-runner | advisory | daily_shadow_feedback | append-only·trade_journal 불변 | C8·2026-06-19 실가동 |

**통합 규칙**:
1. **등록 의무**: 위 27종 + 신규 shadow는 전부 C15 레지스트리 등록(기준 미정의 shadow는 4주 후 자동 "정체 보고" 발화).
2. **표준 경로**: `shadow → supervised_l4(제안·승인 필요) → autonomous_l5(자율, 사후보고)` — 기존 posttrade/lifecycle 체계 전 컴포넌트 확장. enforce형 게이트(16·17)는 `advisory → enforce` 2단.
3. **주간 전수 스캔**: 주간 전략회의에서 레지스트리 27종 상태표 자동 생성(표본·진척·제안 대기) → 마스터에게 "결정 대기 N건" 단일 뷰.
4. **P1 산출물**: 레지스트리 스키마(컴포넌트·모드·기준·표본·이력) + 제안서 생성기 + 일/주간 회의 통합 — CODEX 프롬프트 분리 예정.

### C16. 포지션 런타임 관리자 (G7-b) [마스터 지시 2026-06-12 — 실시간 감시 정밀 분석 + 보유 중 재평가]
**실측 — "실시간 감시"의 실체 (3계층)**:
1. `holding-monitor` launchd 2종 = **시간·정책 폴링**(가격 감시 아님): crypto 6h(stale 보유 sweep, 레짐별 soft-cap 일수)·domestic 30min(`domestic_holding_limit_24h` 강제 청산).
2. `runtime-position-runtime-autopilot`(940줄) = 재평가 오케스트레이션: exitReady/adjustReady 메트릭·cadence autotune·자율 디스패치 게이트·phase6 safety.
3. **`position-reevaluator`(1,949줄)** = 판단 코어: 캔들 변화율·종가위치(closeLocation)·지표 bias(거래소별 임계)→BUY/SELL/HOLD + `computeDynamicTrail`. + `position-watch`(변화 알림)·protective-order(거래소 보호주문) 별도.

**필요성 판정: ✅ 필요 — 단 역할 재정의**. 근거: 진입 사이클과 보유 관리는 시간 척도가 다름(crypto 24/7·KIS 장중). 보유 중 별도 루프는 옳은 구조. **문제 3건**:
- (a) 🔴 **전략군 무인식**: 일반 지표 bias로 판단 → 진입 논리(예: 눌림목)와 청산 논리 단절. 테스타 원칙 위반("진입 근거=차트면 탈출도 같은 논리").
- (b) 시간 기반 강제청산(24h 한도·stale sweep)이 전략군 룰(구조 손절·트레일)과 **충돌 가능** — 추세 타고 있는 포지션을 시간으로 자름.
- (c) "실시간" 아님(30min~6h 폴링) — 단 **틱 레벨은 불필요**(종가 확인 원칙 V-F/V-I + 보호주문이 틱 방어). 캔들 마감 정렬이 정답.

**개선 설계 (G7-b)**:
1. **전략군 인식 재평가**: 포지션에 진입 전략군 태그(C3) → **해당 군의 청산·관리 룰로만 평가** — 터틀=10봉 최저 이탈 종가/트레일 전환 · 눌림목=직전저점/75선 붕괴/분할·추적 · 레인지=반대 라인/중심선. reevaluator의 일반 지표 bias는 **보조 신호로 강등**(플래그만).
2. **캔들 마감 정렬 폴링**: crypto=1h/4h 캔들 마감 직후, KIS=장중 30min+일봉 마감. cadence autotune 재사용(정렬 기준만 변경).
3. **액션 4종**: `hold`(유지) / `exit`(청산: 룰 충족) / `adjust`(트레일 갱신·부분익절·보호주문 재배치) / **`add`(추가매수, 신설)** — 터틀 피라미딩(추세 진행 +0.5×ATR 간격, 군별 최대 유닛, **총 리스크 한도 내**) + 눌림목 재신호. add는 G4 사전 게이트(R:R·E)+자본 게이트(C9 재평가 훅) 통과 필수.
4. **시간 정책 재배치**: stale sweep·24h 한도는 **전략군 룰이 우선, 시간은 후순위 안전망**(soft-cap 유지하되 전략군 룰이 활성 관리 중이면 유예). 단 defensive 레짐·halt에서는 시간 정책 강화.
5. **C15 등록**: "전략군 룰 재평가 vs 기존 지표 bias 재평가"를 shadow 비교(가상 청산 성과 Δ) → 승격 제안.
- 재사용: reevaluator 1,949줄(골격)·dynamic-trail·protective-order·autopilot cadence·holding-monitor(안전망化). 신설=전략군 태그 스키마+군별 청산 룰 평가기+add 유닛 로직.
- **[v1.2] expected-fire 워치독(silent miss 감지)**: 트리거 조건 충족인데 실행 부재(주문·알림 미발생) 감지→경보. 에러 감지(클로드팀)와 별개 차원 — "조용한 누락" 탐지. 구현: 트리거 평가 시 expected-fire 레코드 기록 → N분 내 매칭 실행 없으면 경보 + debrief plan vs actual에 자동 편차 등재. 근거: V-P 실사고(서버 트리거 미발화로 딥 매수 누락). 래더·전략군 진입·청산 룰·C15 제안 발화 전체 적용. **삽입 지점: ET-A(entry-trigger 30분 러너 연결) 완료 후 `entry-trigger-engine.ts` `buildEntryTriggerFireReadiness`(534)·`evaluateEntryTriggers`(1030) / 연결 전이면 30분 러너 전략군→프리플라이트 흐름.** ET 트랙(C3 참조)의 ET-C에서 구현 — would-fire(placed:false) vs 매칭, 테이블 1개·30일 보존(T9).

> **[정합성 노트 2026-06-19 — 메티 소스 실측]** C16 설계 전제 일부가 코드 발전으로 갱신됨: ① **reevaluator는 이미 setup_type 인식** — `getStrategySetupType`+setup별 청산 가드(`breakout_hold_guard` 추세 확인·`mean_reversion_profit_take` 부분익절·`family_performance_protective_adjust`)+`familyPerformanceFeedback` 존재. 따라서 (a) "전략군 무인식"은 부정확 → 정확히는 **C3 정밀 청산 룰(10봉 최저 이탈 종가·75선 붕괴·구조 손절)이 미연결**(현 가드는 거친 수준). ② **`position_strategy_profiles`(66행·setup_type·exit_plan·strategy_context) 기존재** → "전략군 태그 스키마 신설" 불필요. 단 현 분류(defensive_rotation 39·momentum_rotation 12·trend_following 7·micro_swing 5·breakout 2)와 **C3 전략군(turtle/testah/range/defensive) 매핑 필요**. ③ **3시장**: reevaluator는 `binance`(crypto)·`kis`(국내) 거래소별 분기(지표 프레임/가중/임계)·**해외(미국 주식)는 거래소 미등록**(신호 watchlist만·포지션 0). 실데이터 crypto 중심(보유 2·신호 crypto 7/domestic 1/overseas 0). ④ **ET-D 정의 확정**: C3 정밀 청산 룰 평가기(shadow)를 현 setup 가드와 병행 산출 → 가상 청산 성과 Δ 비교 → C15 등록. **3시장 공통 로직**(거래소 컨텍스트 변형)·데이터는 거래소별 누적분 자동 포함·실청산 0(reevaluator 동작 불변).

### C17. 파라미터 스토어 [최종 리뷰 보강 — "동적 제어의 실체" 정식 설계]
> 전 문서에서 11회 전제된 핵심 인프라의 실체 정의. 🔑 **기존 자산 3종 통합·확장**(신설 최소): `runtime-parameter-governance.ts`(203줄 — 키별 거버넌스 티어 escalate/immutable 기존재) + `runtime-config-suggestions`·`runtime-luna-dynamic-policy-operator`(제안·운영 기존재) + `luna_regime_weight_snapshots`(DB 이력 스냅샷 패턴).
- **스키마(신설 1테이블)**: `investment.luna_parameter_store` — `key · value(jsonb) · scope(market/strategy_family/global) · tier(auto|approve|immutable — governance 티어 매핑) · effective_from(T1 적용 시점) · evidence(검증 ID: 백테스트/permutation/C15 제안서 참조) · changed_by(system|meeting|master) · prev_value` + 이력 추적(append-only).
- **적용 메커니즘**: 읽기=사이클 시작 시 1회 로드(T1: 진행 중 사이클 불변, 경계급만 즉시 reload 신호) · 쓰기=①C7 검증 통과 자동(tier=auto) ②회의 ADR(tier=approve, 마스터) ③C15 승격. env/runtime_config는 **폴백+부트스트랩**(스토어 미존재 키는 env 기본값).
- **거버넌스**: 기존 governance 티어 재사용 — auto(레짐 멀티·게이트 임계 등 검증 갱신 가능) / approve(리밋·전략군 추가 등) / immutable(회로차단기·order_rules — 기존 'immutable' 선언 유지).
- **C15 연동**: 파라미터 변경도 0-b 루프(변경→성과 추적→롤백/유지 제안). 구현=P1-1과 동일 CODEX(레지스트리와 한 몸).
- **[v1.2] 제약 집행 분리(Constraint Enforcement Isolation)**: immutable tier(회로차단기·order_rules·주문/일일 한도)는 "선언"이 아닌 **물리 강제** — LLM 에이전트(루나 런타임·코덱스)의 쓰기 권한 밖 배치: ①DB role 분리(immutable 키는 별도 role만 UPDATE 가능) ②설정 파일 무결성 검증(해시 대조, 변조 시 보수 디폴트+경보) ③제약 검사는 주문 경로 인라인(LLM이 우회 불가한 위치). 근거: V-O 실사고 — "LLM이 리스크 제약 서비스를 재배포해 우회". **선행 작업: 루나 에이전트가 자기 제약(runtime-config·env·plist)을 런타임 수정 가능한 경로 실측 감사**(P0-6). **[메티 스팟체크] governance `order_rules:'immutable'`은 선언만(125행) — 쓰기 차단 코드 미발견(P0-6에서 정밀 확정)**.
- **[v1.2 시뮬 2차] break-glass(마스터 수동 오버라이드)**: 물리 강제가 **마스터까지 막으면 안 됨** — 마스터 전용 경로(별도 DB role + CLI 스크립트, 전 사용 감사 로그+텔레그램 통지) 보장. 긴급 상황(서킷 오발동·시장 이상)에서 마스터가 즉시 해제·조정 가능해야 완전자율의 안전판이 성립.

### C18. 브로커 추상화 + 토스증권 통합 [신설 — 2026-06-13, 마스터 지시 / 2026-06-18 본문 통합]
> 마스터 전략: **단기=KIS / 중기·장기=토스**(보유기간 horizon으로 실행 브로커 라우팅). 구현 진행 상태(TOSS-A~E)=TRACKER.

**C18-1. BrokerAdapter 추상화** (`shared/brokers/broker-adapter.ts`): KIS·토스·Binance 단일 인터페이스. 읽기(getQuote/Candles/Holdings/SecuritiesWarning/Calendar/ExchangeRate)·사전검증(getBuyingPower/Sellable/Commission)·실행(placeOrder/amend/cancel — **capability 게이팅: canTrade && liveFireEnabled && 승급완료 3중 조건**, shadow에선 어댑터 실행 메서드 `disabled`(throw)). `selectBroker({horizon})`: short→KIS·mid/long/mid_long→토스. `assertExecutable(adapter)` 단일 실행 게이트.

**C18-2. 토스 클라이언트** (`shared/brokers/toss-client.ts`): OAuth2 Client Credentials(`/oauth2/token` Basic auth)·토큰 50분 캐싱·X-Tossinvest-Account 헤더=**accountSeq**(콜론id/accountNo 자동 환원). 6 카테고리: Market Data(시세·캔들·호가)·Stock Info(종목·**투자유의 securities-warning**)·Market Info(캘린더·환율)·Account/Asset(잔고)·Order(사전검증 3종·주문)·Auth. WS 미공개→REST 폴링(30분 주기 정합).

**C18-3. MCP/A2A/스킬/훅** (신규 서버 신설 금지·기존 재사용): MCP 토스 도구 4종(price/candles/securities-warning/calendar) → marketdata-mcp. A2A 스킬(account-snapshot·preflight-verify). 훅(toss-order-preflight-hook — 승급 후 활성).

**C18-4. 시크릿** (마스터 전용 입력): `bots/hub/secrets-store.json`(600·gitignore)의 `toss` 블록(api_key·secret_key·account·mode·live_trading). 코드는 getSecret 경유·하드코딩 0·`maskSecret` 마스킹·`toss-secret-doctor`(값 미노출 토큰 발급 검증).

**기존 컴포넌트 보강**: C1 게이트(토스 캘린더·시세 교차검증)·C3/C7(캔들 소스·국내 수수료 무료 비용 보정 플래그)·**C4 프리플라이트 외부 진실 교차검증**(buying-power/sellable/commission 대조)·**C14 투자유의 종목 게이트**(관리/환기/유의 자동 배제 — 토스 강점)·C16/C9 잔고 재평가.

**LIVE = shadow→자동승급** (토스 sandbox 부재 → shadow 검증 결정적): **S0 shadow**(would-fire만)→**S1 paper-mirror**(사전검증 실호출+주문 미발행·placed:false)→**S2 micro-live**(1주, 마스터 명시 승인 — 자동 불가)→**S3 scaled**(사이징 정상화). 각 전환=C15 제안. 롤백=`live_trading=false` 한 줄. LIVE 주문=토스 사전검증+C4 프리플라이트+서킷 3중 게이트.

**핵심 시너지 4건**: ①C4 프리플라이트 외부 진실 검증(추정 vs 토스 실제) ②투자유의 종목 자동 배제 ③국내 수수료 무료→백테스트 비용 보정 ④sandbox 부재→shadow 자동승급 설계 결정적.

### 보강 메모 [최종 리뷰 — 소갭 4건 확정]
- **G6 초기값**: LLM 리뷰어 감점 캡 = 최종 스코어의 **−20%**(예: 10점 만점 중 −2), 보조점수 블렌드 가중 = **0.2**(결정론 0.8) — 모두 파라미터 스토어(tier=auto), Stage A 데이터로 보정.
- **G3 A단(discovery) 전략군 프리필터**: 기존 discovery 재사용하되 **전략군별 근접 후보 프리필터 추가**(터틀=20봉 고점 3% 이내 · 눌림목=정배열+5선 거리 · 레인지=박스 형성 — 룰 80% 충족=워치리스트 C10 등록). discovery 자체 교체 아님.
- **Stage A 비교 대시보드 = 신설 UI 없음**: 일일 debrief(§23.2)에 "신구 스택 비교" 1섹션(일치율·가상 E Δ) + 주간 회의 표. :7787 위젯은 P3 선택.
- **C16 폴링 = 기존 holding-monitor 병행**(plist 교체 아님): 기존 2종(6h/30min) 유지(안전망) + 캔들 정렬 폴링 신규 plist 추가(비-PROTECTED).

## 4. 마이그레이션 경로 (무중단 — 하이브리드 Phase 패턴 재사용)
- **Stage A(병행)**: 신규 스택을 **shadow 모드**로 병행 가동(기존 LLM 스택이 LIVE 유지) — 모든 G0~G7 산출을 로깅만. 비교 대시보드(일치율·가상 성과).
- **Stage B(부분 승격)**: 검증 통과 컴포넌트부터 개별 승격(게이트→사이징→전략군 순). 시장별 단계(KIS 먼저=손실 시장, crypto LIVE는 마지막).
- **Stage C(코어 전환)**: 결정 코어 교체(LLM은 G6로). 회로차단기·즉시 롤백(env 플래그) 상시.
- 각 Stage 전환 = Promotion Gate(하이브리드 게이트 패턴) + 마스터 승인.

## 5. 우선순위 로드맵
- **P0(즉시·저위험)**: ①reviewHint 소표본 폐지 ②robust selection ON ③point-in-time 유니버스 실측·교정 ④1-bar shift 감사 ⑤M-5 재평가 훅. → 개별 CODEX 프롬프트.
- **P1(코어 골격 + 제안 인프라)**: C1 게이트 + C2 레짐 승격 + C3 전략군 2종(터틀·눌림목) + C4 사전 게이트 — shadow. **+ C15 레지스트리·제안서 생성기**(shadow 23종 시드 등록·회의 통합 — 이후 모든 shadow의 관리 기반이므로 P1).
- **P2(검증·피드백·포지션)**: C7 permutation·CPCV + C8 피드백 루프 + C5 스코어 융합 + **C16 전략군 인식 재평가**(C3 태그 의존 — shadow 비교로 C15 등록).
- **P3(자율 완성)**: C9~C14 + C16 add 액션 승격 + Stage B/C 승격 + 완전자율 루프(파라미터 스토어 전면).


## 6. 운영 타임라인 + 전체 시뮬레이션 보강 [v0.3 — 루나팀 하루 워크스루 결과]
> 시뮬레이션: 평일 1일(KIS 장중·crypto 24/7·미국장 야간) + 주말(주간회의) 운영을 마스터 루틴 비전(§0) 위에서 워크스루. 도출 갭 7건(T1~T7) → 보강.

**하루 표준 타임라인(KST)**:
```
04:50  G0/G1/G2 사전 산출(시장별) + plan-note 생성(미국 마감 직후 데이터)
05:00–06:00  아침 통합 회의(미국 장후 평가+국내 장전 계획+crypto 점검, §23) → 영향 변수 주입
09:00–15:30  KIS: G3 스캐너 → G4~G7 진입 → C16(30분 캔들 정렬)
16:00  국내 장후 평가(debrief): plan vs actual 대조 → C8 입력·익일 보정 [§23.2]
22:00  미국 장전 점검(경량·자율, 미 거래일)
23:30–06:00  미국장: 동일 스택, 시장별 게이트 독립
상시   crypto: 1h/4h 캔들 마감마다 C16 · 4h마다 G3 스캔 · G0/G1 갱신
일요일 06:00  주간 회의: C15 전수 스캔·전략군 부패·C8 가설 + 3시장 비교 성과
```
- **T1 파라미터 적용 시점 규칙**: 회의·C15 결정의 파라미터 변경은 **다음 사이클부터 적용**(진행 중 사이클 불변) — 단 경계급(halt·회로차단·리밋 축소)은 **즉시 적용**. 적용 시점은 파라미터 스토어 이력에 기록(검증 가능).
- **T2 Stage A 피기백**: 신규 스택(G0~G7) shadow는 **기존 luna-cycle에 피기백**(같은 사이클 내 병행 산출·로깅) — 별도 launchd 신설 최소화(C16 캔들 정렬 폴링만 예외).
- **T3 halt 시퀀스 명문화**: G0 halt 진입 → ①신규 진입 중단+EXIT만 ②C16 트레일 타이트닝(defensive) ③수시회의 자동 소집(U4 자율 모드) ④마스터 알림(경계급) ⑤해제=G0 회복(>40 재진입 + 지속 2캔들) **+ 회의 결정**(자동 해제 금지).
- **T4 C15 제안 위생**: 다수 컴포넌트 동시 기준 충족 시 — 긴급(중단·롤백 제안)만 즉시, **승격 제안은 주간 배치 기본**(일일 상한 2건). 제안 큐=우선순위(경계>성과>표본).
- **T5 피드백 루프 주기**: C8 통계 갱신=일일(장 마감 후) · 가설 생성→C7 검증 제출=주간 · 파라미터 자동 갱신=검증 통과 시점(T1 규칙 적용).
- **T6 워치리스트 장중 충족**: 진입조건 충족 → Stage A=shadow 기록+알림만 / Stage B+=G4 통과 시 자동 진입(**마스터 사전 위임 범위 내** — 위임 범위는 회의 결정·파라미터 스토어).
- **T8 [시뮬 2차] 서킷 vs G0 halt 중첩**: 손실빈도 서킷(C4)·G0 halt 동시/중첩 발동 시 **보수 우선**(더 제한적인 상태 적용), 해제는 각자 조건 독립(서킷=시간 만료, halt=G0 회복+회의 결정). 상태는 단일 뷰(어떤 제한이 왜 활성인지)로 회의·debrief에 표시.
- **T9 [시뮬 2차] expected-fire 레코드 운영**: 테이블 1개(트리거ID·조건 스냅샷·기대 액션·매칭 결과·시각), 보존 30일, debrief에서 미발화 편차 자동 등재 후 주간 정리.
- **T10 [시뮬 2차] 서킷 발동 수시회의 안건 표준**: 원인 3분류(룰 결함/레짐 오판/시장 이상) → 분류별 후속(룰=C15 중단 제안 검토 · 레짐=C2 캘리브레이션 점검 · 시장=G0 임계 점검) — grill 적용, 재발 방지 결정을 ADR로.
- **T7 시장별 게이트 독립+전이**: 3시장 G0는 독립 산출하되 전이 신호(미국→한국·crypto) 포함(C1 정의대로). 미국장 진행 중 새벽 회의는 "마감 전 스냅샷" 기준임을 morning-note에 명시(데이터 시점 정직성).

## 7. 확정 사항 + 다음 작업 (2026-06-14 마스터 승인 — 설계 확정)
**마스터 확인 6건 → 권고안 일괄 승인(확정)**:
- ① G0 임계 초기값 = full>70 / reduced 40–70(사이징 60%) / halt<40 — Stage A 데이터로 보정(파라미터 스토어 tier=auto).
- ② C3 룰셋 초기값 = 터틀 20/10·2×ATR(20) · 테스타 5/25/75 · R:R≥2 — stable-range 백테스트로 확정.
- ③ C9 동적 리밋 = 기본 15 × 레짐 × E부호 × 배치율, **상한 캡 30**(현행 2배).
- ④ P0-1 교정 = closedTrades 3→**30** 상향 + **델타 절반**(점진 — 완전 비활성 아님).
- ⑤ Stage A 목표 = **4주 · 전략군별 신호 30+ · 가상 E가 LIVE 대비 우월** — C15 등록 시 기준으로 확정.
- ⑥ C13 분석가 ablation = **P3 유지**(데이터 누적 후).
**다음 작업**: 1. P0 CODEX(`docs/codex/CODEX_LUNA_P0_BATCH.md`) 작성 → 코덱스 실행 → 메티 독립 검증 → 마스터 커밋. 2. P1-1(C15 레지스트리+C17 파라미터 스토어) CODEX. 3. C1~C4 CODEX.
