# 루나 최적 재설계 — 구현 추적 (TRACKER)

> v1.1 (2026-06-11 종합 갱신) · 작성: 메티 · SSOT=LUNA_OPTIMAL_REDESIGN.md(**v1.3**) · 회의실=MEETING_ROOM_DESIGN(v0.7) · 입력=LUNA_LOGIC_REANALYSIS.md
> 주의: 일부 과거 기록 날짜(06-13~19 표기)는 오류 — 실제 작업일 2026-06-10~11.
> **우산 관계**: 본 트래커가 재설계 상위 추적. 회의실(WS-A~E·G·Q)=MEETING_ROOM_TRACKER 유지(C11 트랙). 겹치는 WS는 본 트래커로 합류(이중 추적 금지).
> 원칙: 무중단(PROTECTED·crypto LIVE·스카) · shadow→L4→L5 표준 경로(C15) · 검증 통과분만 승격 · 마스터=게이트.

## 📊 종합 현황 (2026-06-11)
- **P0: 6/6 ✅**(커밋 687ece025) · **P1: 7/7 ✅** · **MR-A ✅** · **MR-B 구현 완료**(자체 서버 7791·빌드리스 React·결정 대기함 confirm/defer·U1 캐치업·repo plist 초안, 등록=마스터) · 다음=MR-C → P2
- **가동 자산**: DB 10종(`luna_parameter_store` append-only·seed 7 / `luna_component_registry` **31종 active** / `luna_market_gate_history` / `luna_regime_calibration` / `luna_strategy_signals` / `luna_entry_preflight_log` / `luna_circuit_locks` / `luna_meeting_sessions` / `luna_meeting_minutes` / `luna_meeting_decisions`) · 모듈 7종(parameter-store·market-deployment-gate·registry-evaluator·regime-engine·strategy-families·command-policy·meeting-room) · 스모크 6종(전부 ROLLBACK 위생)
- **🏛️ 첫 공식 회의 기록(2026-06-11 --apply)**: 세션 #1(morning·chair=luna)·minutes 56·**ADR 9건 pending_master(due 6-12)** — 시장 3+C15 대기 5+서킷 1. 회의실이 자기 승격 안건 자체 상정(0-b 자기 적용). 마스터 결정 대기함 운영 시작(현재 창구=회의록 md, 웹=MR-B·텔레그램=MR-C).
- **🟢 C15 루프 실가동(2026-06-11)**: plist 2건 등록·kickstart 완료 — `ai.luna.market-gate-30min`(게이트+레짐 30분 적재, DB 이력 확인) · `ai.luna.registry-evaluator-daily`(**--apply 모드** — 25종 last_evaluated_at 갱신 확인). 일일 평가→기준 충족 시 텔레그램 제안(상한 2) 자동.
- **감사 산출물**: P0_4_LOOKAHEAD_AUDIT(잔존 4건→P1-6) · P0_6_CONSTRAINT_AUDIT(방어 양호→P1-7 완료 근거)

## 기존 WS 매핑 (MEETING_ROOM_TRACKER v0.4 → 재설계)
| 기존 WS | 재설계 합류처 | 처리 |
|---|---|---|
| WS-R 알파팩터 | C12+C5 | 합류(CODEX_LUNA_ALPHA_FACTOR v1.3 갱신 완료 — P1-4 병행 실행) |
| WS-J 레짐 | C2 | 합류(HMM core 승격+전이행렬) |
| WS-K 검증·WS-F CPCV | C7 | 합류(+permutation 2종·point-in-time·OOS 보존) |
| WS-N 수급 | C1+C14 | 합류 |
| WS-O 출구·사이징 | C3+G5+G7 | 합류 |
| WS-L 자기개선·WS-H 학습 | C8+0-b | 합류(temporal/CVRF=P3) |
| WS-I 리스크 훅 | 독립(B-13) | 병행 |
| WS-M 스킬·WS-P 비용 | 직교 | 병행(grill=Phase 1 승격) |
| WS-A~E·G·Q 회의실 | C11 | MEETING_ROOM_TRACKER 계속(이벤트 트리거만 본 트래커 P2) |

## P0 — ✅ 6/6 완료 (구현=코덱스, 검증=메티, 커밋 687ece025)
> 검증: tsc 0·review-hint PASS·closeout 24/24 재실행·코드 스팟·감사 2건 판정. 타입 3파일 커밋 완료(155be1c7f).
> 설계 확정: G0=70/40·60% / C3 초기값 / 리밋 상한 30 / Stage A=4주·30신호·E우월 / ablation=P3.
- **P0-1** ✅ reviewHint 교정 — `team/luna.ts` closedTrades 3→30+델타 절반, 상수 추출, 경계 스모크
- **P0-2** ✅ robust selection — 기활성 확인(plist 2종), 스모크 검증
- **P0-3** ✅ point-in-time 메타 — `universe_asof`·`universe_source` additive
- **P0-4** ✅ 룩어헤드 감사 — partial pass: 잔존 4건(rsi_macd 현재봉·close 체결·마지막봉·slippage opt-in)→P1-6
- **P0-5** ✅ 재평가 훅 — `finalizeCloseout`→`invalidateCapitalSnapshot`(성공 매도만·가드·멱등)
- **P0-6** ✅ 제약 감사 — 직접 자기수정 경로 없음 판정(freeze·confirm·approved·clamp), 잔존=셸 권한·--force→P1-7

## P1 — 코어 골격 + 제안 인프라 [shadow]
- **P1-1** ✅ **C15 레지스트리+C17 파라미터 스토어**(2026-06-11, 메티 검증): 테이블 2종(registry 23 시드·param seed 7·append-only 트리거)·스토어(immutable 강제·env 폴백·T1 캐시)·평가기(readyForPromotion·제안 3종·텔레그램 상한 2·일일 리포트 1줄)·스모크 ROLLBACK 위생(누적 0 재현). 잔여 메모: `shadow_unvalidated_passthrough` 태그 구분=평가기 정밀화 시 확인.
- **P1-2** ✅ **C1 시장 배치 게이트**(2026-06-11, 메티 검증·마스터 적용): 3시장 합성(결측 내성 재정규화·C17 첫 소비·T7 전이 0.2)·이력 테이블·레지스트리 24종. 가용성 실측: US 2/4(기간구조·put-call 미구성)·KR 4/4·crypto 4/5(도미넌스 미구성). 신호 품질 메모: `us_benchmark_trend` 이산 매핑(bearish→0)=C15 캘리브레이션 대상 · 미구성 3신호=C14 소스 후보.
- **P1-3** ✅ **C2 레짐 승격**(2026-06-11, 코덱스 구현·마스터 적용): `luna-regime-engine` shadow 파사드(detectHMMRegime 우선·getMarketRegime 폴백 0.55)·시장 sentinel(`__market__`)·전이 경보 U5 위생·Brier HMM vs fallback 캘리브레이션·G0 market-gate runner 독립 통합·일일 리포트 1줄. migration 적용 완료(`luna_regime_calibration`, `hmm_regime_log.source/transition_alert`)·레지스트리 25종. 경미 후속: summary 괄호값=confidence→dominant 확률 표기 변경(다음 사이클 1줄). 관찰: 확률 시점 변동성=Brier 판정 영역.
- **P1-4** ✅ **C3 전략군 룰셋**(2026-06-11, 메티 검증·마스터 적용): 터틀(20/10·2ATR·SMA200·종가 돌파)+테스타(5/25/75 정배열·재돌파)·rr 사전 산출(rr<1 무효)·G1 레짐 스냅샷+matched 플래그·signals 테이블(UNIQUE 멱등)·러너 G0→G1→G2/G3 3단계·레지스트리 27종·c3 파라미터 시드 11건. 실데이터 검증: HOME/USDT 테스타 entry rr=4.18 matched=false(bear 레짐 정확 동작). 백테스트 정합 표=P1-4b 입력(P1_4_BACKTEST_ALIGNMENT.md). P1-3 후속(dominant 확률 표기) 반영 완료.
- **P1-5** ✅ **C4 프리플라이트+서킷 3종**(2026-06-11, 메티 검증·마스터 적용): 🔴P1-4 미완성봉 결함 수정(`dropIncompleteLastBar` — 2회 연속 동일 결과 재현)·4게이트(rr/E 30거래 규율/횡보/유동성 결측내성)·서킷 3레벨(trade_journal 소스 — 실데이터 잠금 20건: 저수익 15+쿨다운 5)·러너 5단계 완성·테이블 2종·c4 시드 9건·레지스트리 29종. 약신호 게이트 실측: luna.ts binance 0.22/0.03·기타 0.32/0.08(대체 비교=후속).
- **P1-6** ✅ **next-bar 백테스트 shadow**(2026-06-11, 메티 검증·적용): 플래그 기본 OFF(회귀 diff 0 확정)·마스크 1봉 시프트 단일 지점·next_open 체결(시그니처 검사)·비교 스모크(수익 -0.04p·MDD -0.10p — 체결 지연 영향 첫 정량화)·레지스트리 30종(advisory). P0-4 잔존 ①②③ 해소.
- **P1-7** ✅ 제약 가드(P1-1 포함): block 단언 스모크+`luna-autonomous-command-policy.ts`. 자율 러너 적용 지점=메티 검토 후.
- **P1-OPS** ✅ **운영 보정 3건**(2026-06-11, 메티 실측 재현 검증): 레짐 시장당 1행(66배 과다 해소)·캘리브레이션 registry-evaluator 피기백(--skip-calibration·fail-open)·서킷 중복 억제(활성 동일 잠금 skip). 다음 일일 --apply 주기부터 Brier 실적재.
- **MR-A** ✅ **회의실 백엔드+FSM+회의록**(2026-06-11, 메티 검증·마스터 적용): 테이블 3종(sessions·minutes·decisions[ADR grade·due_at])·stack-adapter(P1 스택 6종→plan-note·U9 5분 브리프)·FSM(안건 자동 생성: 세그먼트3+C15 대기4+서킷1)·grill 5문(불충분=c_master 강등)·LLM 비용 가드(6회 상한 실측)·--no-llm 폴백·CLI 완주(회의록 610줄 2종 정독 합격)·레지스트리 31종. 🌟C15 결정 대기→회의 안건 자동 등재(루프 연결). 경미 메모: 서킷 활성 필터 정밀화·LLM 발언 번역투(MR-B/C). 다음: MR-B(웹 2화면)·MR-C(정례화·텔레그램·grill skill)
- WS-R 알파팩터(→C12): CODEX 갱신 완료 — P1-4와 병행 실행 가능.

## P2 — 검증·피드백·포지션
- C7 permutation 2종+CPCV+point-in-time 전면 · C8 피드백(30거래 규율) · C5 스코어 융합 · C16 전략군 인식 재평가+expected-fire 워치독(삽입점=entry-trigger-engine:534/1030·T9 테이블 30일) · C11 이벤트 수시회의 · WS-I 리스크 훅.

## P3 — 자율 완성
- C9 동적 리밋 · C10 워치리스트 · C12 일원화 · C13 ablation·라우팅 · C14 오토리서치·소스 · C16 add 승격 · Stage B/C · 파라미터 스토어 전면 소비 전환.

## 회의실 연동 구현(분담)
- 수시회의 트리거 ⑥서킷(T10 안건 표준)·⑦silent miss — P2 · ADR ID=evidence 상호 참조(P1-1 스키마) · debrief 미발화 행(G6 생성기) · 회의 결정 기한+미이행 재상정(P2).

## 무중단 체크리스트
- [ ] PROTECTED 미중지 · crypto LIVE·스카 무중단 · 신규 plist=비-PROTECTED · shadow 우선 · point-in-time/누수 차단.

## CODEX 순서 (현행화)
1. ✅ P0_BATCH(6건) 2. ✅ P1_REGISTRY_PARAMSTORE 3. ✅ P1_2_MARKET_GATE → **4. P1_3_REGIME_ENGINE(작성 예정)** → 5. P1-4(C3)·ALPHA_FACTOR 병행 → 6. P1-5 → 7. P1-6 → 회의실 Phase1(병행)
- 아카이브: docs/codex/archive/(완료 5건). 현역: ALPHA_FACTOR(P1 대기)·완료 CODEX 3건.
