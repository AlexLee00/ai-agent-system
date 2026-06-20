# 루나 최적 재설계 — 구현 추적 (TRACKER)

> v1.1 (2026-06-11 종합 갱신) · 작성: 메티 · SSOT=LUNA_OPTIMAL_REDESIGN.md(**v1.3**) · 회의실=MEETING_ROOM_DESIGN(v0.7) · 입력=LUNA_LOGIC_REANALYSIS.md
> 주의: 일부 과거 기록 날짜(06-13~19 표기)는 오류 — 실제 작업일 2026-06-10~11.
> **우산 관계**: 본 트래커가 재설계 상위 추적. 회의실(WS-A~E·G·Q)=MEETING_ROOM_TRACKER 유지(C11 트랙). 겹치는 WS는 본 트래커로 합류(이중 추적 금지).
> 원칙: 무중단(PROTECTED·crypto LIVE·스카) · shadow→L4→L5 표준 경로(C15) · 검증 통과분만 승격 · 마스터=게이트.

## 📊 종합 현황 (2026-06-11)
> **[2026-06-18 설계문서 통합]** LUNA 설계문서 12→현역 6개. TOSS·ET 증분을 메인 OPTIMAL_REDESIGN(C18/C3/C16)에 흡수·별도 문서 삭제. 6/8 선행 분석 4종(VIDEO·BOOST_DESIGN·BOOST_APPLY·GROWTH)→`archive/luna-precursor/`. 현역=OPTIMAL_REDESIGN(+TRACKER)·LOGIC_REANALYSIS·회의실 3종.
- **P0: 6/6 ✅**(커밋 687ece025) · **P1: 7/7 ✅** · **MR-A ✅** · **MR-B ✅ 가동**(2026-06-12 메티 검증·launchd `ai.luna.meeting-room-web`@127.0.0.1:7791 — 빌드리스 2화면·결정 대기함·캐치업·@멘션 가드) · 다음=완료 — **🏛️ 회의실 3분할 완주(2026-06-12)**: MR-A(두뇌)+MR-B(웹 7791)+MR-C(정례 4종 launchd 등록·텔레그램 원클릭[Hub route 활성]·grill skill 2종·G6 debrief·CLI 위생 FIX) → 다음=**갈림길: ALPHA_FACTOR vs P2**
- **MR-FIX 2~4** ✅ **회의실 표시 품질 3종**(2026-06-12, 메티 검증·웹 재기동): ②마크다운 경량 렌더(innerHTML 무사용·XSS 회귀 검증) ③C15 대기·서킷 안건 JSON 덤프→한국어 요약(원본=meta/evidence 보존) ④서킷 활성 집계 행수→distinct(54→18건 정확화 — 전 표시처 통일). 마스터 브라우저 점검에서 발견·당일 종결.
- **가동 자산**: DB 10종(`luna_parameter_store` append-only·seed 7 / `luna_component_registry` **31종 active** / `luna_market_gate_history` / `luna_regime_calibration` / `luna_strategy_signals` / `luna_entry_preflight_log` / `luna_circuit_locks` / `luna_meeting_sessions` / `luna_meeting_minutes` / `luna_meeting_decisions`) · 모듈 7종(parameter-store·market-deployment-gate·registry-evaluator·regime-engine·strategy-families·command-policy·meeting-room) · 스모크 6종(전부 ROLLBACK 위생)
- **🏛️ 첫 공식 회의 기록(2026-06-11 --apply)**: 세션 #1(morning·chair=luna)·minutes 56·**ADR 9건 pending_master(due 6-12)** — 시장 3+C15 대기 5+서킷 1. 회의실이 자기 승격 안건 자체 상정(0-b 자기 적용). 마스터 결정 대기함 운영 시작 — **창구: 웹 가동 중(http://127.0.0.1:7791)** + 회의록 md, 텔레그램=MR-C.
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
- **MR-C** ✅ **정례화+텔레그램 원클릭+grill skill**(2026-06-12): 정례 4종 launchd(morning 05:00·debrief 16:00 평일·premarket 22:00·weekly 일 06:00)·텔레그램 원클릭(`luna_meeting:<id>:confirm|defer`·Hub route 활성)·grill skill 2종·G6 debrief 대조표. CLI 위생 FIX(type 파싱·dry-run 분리·--regenerate).
- **MR-주말보정** ✅ (2026-06-13, f52d5e93b): 주말 스킵 안건 LLM 생략(segment_skipped·호출 상한 미소모)·안건 인지형 결정론 그릴(grillEvidenceFocus). 정례 자동 가동 확인(토 05:00 세션 154).
- **MR-UX 개편 1차** ✅ (2026-06-13, 메티 검증·실화면 합격): 질문형 결정 카드(question/ifConfirm/ifDefer/safetyLabel)·글로서리 평이화 레이어(halt→신규 진입 중단 등 원어 병기)·안건별 접힘 타임라인·ADR 중복 억제(reappearedCount·일괄 보류)·SCENARIO.md. 마스터 피드백 4건 해소. 경미: 웹 서버 인자 파서 등호 전용(1줄 후보).
- WS-R 알파팩터(→C12): CODEX 갱신 완료 — P1-4와 병행 실행 가능 / **다음 갈림길: ALPHA_FACTOR vs P2**.

## ALPHA·소형 (2026-06-13 완료)
- **ALPHA·paper-mirror 정례화 ✅** (2026-06-13, 메티 검증): evaluator-daily 피기백(신규 plist 0·캘리브레이션 동일 패턴·독립 try/catch·--skip-alpha/--skip-paper-mirror). ALPHA --apply 데이터 축적 확인(0→2·value_reversal_quality IC=0.131·gate 통과). **커밋 후 다음 evaluator 일일 주기부터 자동 축적**. paper-mirror=신호 0이라 현재 0(신호 생기면 기록).
- **📊 데이터 축적 관찰 대상**(다음 세션 점검): luna_alpha_factors(누적·IC 추이·승격 후보 발생) · luna_toss_paper_mirror_log(신호 발생 시 일치율) · Stage A 표본(전략군 30신호·E 우월·~7/9 판정).
- **L-소형** ✅ (597c785c3): 회의실 웹 파서 공백 형식 지원 + 테스트 자동화 3건(W-21 raw JSON 부재·W-50 세션 증가·W-24 반복 문장 실회의록).
- **ALPHA_FACTOR(WS-R/C12)** ✅ (2026-06-13, 메티 룩어헤드 직접 재현 검증): LLM 팩터 생성기·IC/RankIC/RankIR 평가·**룩어헤드 3중 방어**(표현식 금지필드·row 미래필드·point-in-time 배제 — 합성데이터 IC=0.07 누수 0 확인)·hypothesis 필수(경제 가설)·candidate-backtest-gate 재사용·shadow 저장·C15 게이팅(자동승격 0). 테이블 luna_alpha_factors·_evaluations·c12.alpha.* 시드 5·레지스트리 38종.

## P2 — 검증·피드백·포지션
- C7 permutation 2종+CPCV+point-in-time 전면 · C8 피드백(30거래 규율) · C5 스코어 융합 · C16 전략군 인식 재평가+expected-fire 워치독(삽입점=entry-trigger-engine:534/1030·T9 테이블 30일) · C11 이벤트 수시회의 · WS-I 리스크 훅.
### C7 검증 전면 분할 (2026-06-18~, L-P2b)
> 갭 분석: 룩어헤드(.shift(1))·OOS skew/kurt·robust selection·DSR/PBO migration **기존 구현**. 진짜 갭=permutation·CPCV·point-in-time.
- **C7-2 permutation ✅** (2026-06-18, 메티 검증): backtest-vectorbt.py IS/WF permutation(신호 시점 block-shuffle→null sharpe→p-value)·`LUNA_BT_PERMUTATION_ENABLED` OFF 기본 diff 0·permutation_gate shadow. **합성 검증: 추세 p=0.008(진짜)·random p=0.705(우연) 정확 구분**. 경미: 스모크 자체 seed(env 무반영).
- **C7-3 CPCV purge+embargo ✅** (2026-06-19, 메티 검증): 기존 `compute_pbo_from_returns_matrix`(CSCV combinatorial 완비)에 purge_gap+embargo_pct 보강·`LUNA_PBO_PURGE_GAP`/`EMBARGO_PCT` 기본 0 diff 0. **합성 경계누출 검증: purge로 PBO 0.06→0.16 보수화**(누출 제거).
- **C7-1 진단 ✅ + universe_snapshot 축적 ✅** (2026-06-19, 메티): 생존편향 확인(universe_asof 메타만·fetch now()·candidate_universe upsert+TTL로 시점이력 미보존). 후속=`universe_snapshot`(append-only·UNIQUE·40종) + evaluator 피기백(일1회·신규plist 0). 검증: 오늘 16종목 축적·멱등(재실행 0). 과거 소급 불가→지금부터 축적·미래 asof 연결 후속.
- **C7 검증 파이프라인 완성**: permutation(유의성)+CPCV(과적합)+생존편향(진단·snapshot). asof 백테스트 연결만 데이터 축적 후 후속.

## TOSS — 토스증권 Open API 통합 (2026-06-13 설계, 마스터 지시)
> 설계 SSOT: `LUNA_OPTIMAL_REDESIGN.md` C18(2026-06-18 본문 통합) · 전부 shadow/advisory 우선·LIVE=자동승급(S0~S3)
- **설계 ✅**(2026-06-13, 메티): 토스 공식 가이드 정밀 분석(OAuth2·6 카테고리·sandbox 부재 확인) + 기존 KIS/secrets/MCP/A2A 실측 → C18 브로커 추상화 신설 + 기존 7컴포넌트 보강 설계.
- **TOSS-A** ✅ (2026-06-13, 메티 직접 실접속 검증): 시크릿 매핑(toss_*·maskSecret)·읽기 전용 클라이언트(OAuth2 토큰 50분 캐싱·시세/캔들/캘린더/환율/투자유의/계좌)·secret-doctor(값 미노출). **🔌 토스 API 첫 실접속 성공**: 토큰 발급 OK(만료 24h)·시세 권한 OK·계좌 발견(마스킹됨, BROKERAGE). 정적: 하드코딩 0·실행 메서드 0·canTrade=false.
- **TOSS-B** ✅ (2026-06-13, 메티 검증): BrokerAdapter 추상화·Toss/KIS 읽기 어댑터·라우터(**단기=KIS/중장기=토스** — 마스터 전략)·MCP 토스 도구 4종. 어댑터 경유 실시세 확인(삼성전자 336,000). canTrade=false·assertExecutable throw.
- **TOSS-C** ✅ (2026-06-13, 메티 검증): 투자유의 종목 게이트(404 정정·유니버스 순회·fail-open)·C4 토스 사전검증 교차검증(account 있으면 recorded)·백테스트 비용 보정(플래그 OFF diff 0). 5종목 순회 실조회 확인.
- **TOSS-D** ✅ (2026-06-13, 메티 검증): 계좌 헤더(accountSeq 자동 환원 — 공식 가이드 `X-Tossinvest-Account:1`)·잔고 소스·A2A 스킬 2종·훅·**S0/S1 paper-mirror**(사전검증 실호출+placed:false)·promotion-stage(기본 s0)·테이블 luna_toss_paper_mirror_log·레지스트리 37종. 잔고·매수가능금액 실호출 성공·placeOrder disabled(실주문 물리 차단).
- **TOSS-E**(보류): S2 micro-live — 마스터 S1 검증 후 명시 승인 시에만.
- 핵심 시너지: ①C4 프리플라이트 외부 진실 검증 ②투자유의 종목 자동 배제 ③국내 수수료 무료→백테스트 비용 보정 ④sandbox 부재→shadow 자동승급 설계 결정적.

## ET — 진입 트리거 정교화 + 발화 레이어 (2026-06-18 설계, 마스터 지시 B)
> 설계 SSOT: `LUNA_OPTIMAL_REDESIGN.md` C3·C16(2026-06-18 본문 통합) · 전부 shadow·**liveFireEnabled=false 강제→실발화 0**
- **설계 ✅**(2026-06-18, 메티): entry-trigger-engine 재사용 연결 설계. **자기수정**: "구세대 잔재" 오판 정정 — worker만 5/4 retired, 엔진은 **C3 재사용 자산**(리테스트/래더 트리거 확장). shadow 게이팅 내장 확인(`shouldAllowLiveEntryFire()`=liveFireEnabled false면 무조건 false). 현재 30분 러너=전략군 기본 룰만, 정교 트리거·발화 레이어 미연결.
- **ET-A** ✅ (2026-06-18, 메티 검증·**시동**): 전략군 신호→trigger candidate 어댑터(BUY·confidence 매핑) + 30분 러너 shadow 연결(`entryTriggerShadowEnabled` 분기·liveFireEnabled=false **throw 강제**) + `LUNA_ENTRY_TRIGGER_SHADOW=true` plist 활성. 검증: fired:0·allowLiveFire:false·armed 동작. **30분마다 자동 평가 — 전략군 신호 발생 시 armed 축적 시작**.
- **🔍 entry-trigger crypto 가동 발견**(2026-06-18): entry-trigger-engine은 worker(주식) retired였으나 **crypto 파이프라인에서 가동 중**(mtf_alignment·fired 매일 2~8건·crypto LIVE 일부). ET-A(주식 kis)와 같은 entry_triggers 테이블 공유하나 **exchange로 격리**(주식=kis·crypto=binance). ET-A 시동 후 crypto 무중단·주식 fired 0 검증 완료.
- **📊 ET 관찰 대상**: entry_triggers(armed 누적·전략군 신호 발생 시·**전략군 신호 6건으로 적어 ET-B 시기상조**) — ET-B 판단 근거.
- **ET-B**(대기): 리테스트/래더 관찰 후 신세대 정리·would-fire(placed:false, paper-mirror 패턴).
- **ET-C**(대기): C16 expected-fire 워치독(would-fire vs 매칭) + debrief 미발화 편차 등재 + 수시회의⑦. 테이블 1개·30일(T9).
- **ET-D**(대기): C15 등록(전략군 룰 재평가 vs 기본 shadow 비교)·승급.
- 접근: 통째 연결 관찰→유용 로직 추출(처음부터 추출 시 재구현 위험).

## C8 피드백 루프 — 시스템 보강 (2026-06-19, 메티 설계·실가동)
> 배경: argona 인스타 AI 트레이딩 딥서치 → 디벙크 사례 다수(스크린샷 조작·과적합·실제 손실) 확인 → **자체 시스템 보강으로 피벗**(Dave Cliff: 측정·학습 능력이 견고함).
- **🔍 진단(메티 자기수정)**: C8 인프라는 풍부(trade_journal 773행·daily-trade-feedback·learning-loop-report)하나 **실거래(crypto normal) 기반**. 진짜 구멍=전략군 shadow 신호(strategy_signals·shadowOnly·trade_journal 연결 0)의 **결과 추적 부재**(outcome 흔적 0).
- **C8 신호 피드백 루프 ✅ 실가동**(2026-06-19):
  - 테이블 `luna_strategy_signal_outcomes`(append-only·UNIQUE signal_id·shadow_only·인덱스 3)
  - 판정 `luna-signal-outcome.ts`: entry 신호(진입가/목표/손절)→OHLCV→target 먼저=win(+rrR)·stop 먼저=loss(-1R)·**동시 도달 시 stop 우선**(백테스트 비관 가정)·**룩어헤드 차단**(candle_ts 익일부터·당일 봉 제외)·maxBars 20 경과=expired·미도달=open
  - 러너 `runtime-luna-signal-outcome-eval.ts`(confirm 토큰 가드)·**evaluator-daily 피기백**(매일 06:20)
  - 집계 전략군×레짐 E/R:R·**30거래 규율**(n<30 insufficient_sample provisional·승률 단독 금지)
  - 검증(메티): 합성 win/loss/stop우선/expired/open 정확·룩어헤드 차단·멱등(재실행 evaluated 0·중복 없음)·**005930 실평가=win**(target_hit·+1.36R·+14.73%·5봉·kis_1d_ohlcv)
  - shadow/advisory·실거래 0·파라미터 자동 갱신 금지(C7 통과 시에만 — SSOT C8)
- **📊 관찰 대상**: 매일 06:20 evaluator가 미종결 entry 신호 평가 → outcome 누적. 30거래/전략군×레짐 충족 시 정식 통계. **레짐 확대 would-have 신호 유효성 평가에 연결**(확대로 잡힌 신호가 실제 수익이었나).

## 신호 병목 진단 + 레짐 확대 (2026-06-19, 메티 진단·마스터 지시)
> 진단 배경: 전략군 신호 6건뿐(유효 entry 1건)·게이트 1089평가. ET-B·C8·Stage A 공통 발목.
- **🔍 신호 부족 근본 원인 진단 ✅**(2026-06-19): **4중 필터 곱셈** — 게이트 통과(full/reduced ~70%)×레짐 매칭(testah:['bull']만·turtle:['bull','volatile'])×전략 패턴(돌파/풀백 까다로움)×일봉 완성봉(하루 1회). turtle은 신호 0건(돌파 조건 미충족). 레짐 라벨 4종(bull/bear/sideways/volatile)·domestic/overseas는 bull 우세. **버그 아닌 보수적 설계** — 안전하나 검증 데이터 정체.
- **레짐 확대 shadow ✅ + 시동**(2026-06-19, 메티 검증): `attachRegimeToSignal`에 expandedRegimes 시뮬레이션(would-have 매칭)·`regimeExpansionGain`(matched=false인데 확대 시 매칭). bear 역추세 자동 제외·sideways만 추가(turtle/testah). **matched 무변경**(실거래 0)·`LUNA_REGIME_EXPANSION_SHADOW` OFF diff 0. 검증: sideways gain=true·bear gain=false·matched 무변경. **30분 러너 시동**(plist 환경변수·enabled=true·gainCount=0 첫 사이클). 며칠 관찰 후 실제 확대 결정.
- **📊 레짐 확대 관찰 대상**: regimeExpansionGain 신호 수(sideways 레짐에서 풀백/돌파 발생 시 +N) → 확대 유효성 판단 근거.

## 자동승격 레지스트리 정합 (2026-06-19, 메티 분석·CODEX-1·커밋 9e0a4d0c7)
> 배경: 신규 shadow 4종(regime-expansion·pattern-relaxation·signal-outcome 2종) 등록 누락 발견 → 등록 자동화 + 승격 판정 구조적 결함 발견·해소.
- **C15 등록 자동화 ✅**(권고1): evaluator(registry-evaluator-daily)가 평가 전 `seedLunaComponentRegistry` 멱등 반영 → 신규 shadow 자동 등록. RETURNING `xmax='0'::xid` 트릭으로 inserted/updated 집계·**fail-open**·dryRun 미반영·sample_count/status 보존(ON CONFLICT EXCLUDED 제외)·regime-expansion SAMPLE_COUNT 쿼리(COALESCE null 안전) 추가. 검증(메티): dryRun seeded=44/applied=0·confirm 토큰 거부·기존 sample(31만) 보존·tsc.
- **승격 판정 구조적 결함 발견 ✅**: `proposalForRow`가 readyForPromotion(보유 0)·minTrades(2)만 봐서 **sample 31만(position-lifecycle)이어도 proposals 0**. 실제 criteria 스키마(metrics 22·durationWeeks 20·evidence 15·minSamplesPerFamilyRegime·virtualExpectancyDeltaPositive 등 27패턴)와 완전 불일치 → 자동승격 평가가 무의미하던 상태.
- **승격 판정 정합 1단계 ✅**(CODEX-1): proposalForRow **6상태** 재설계 — halt_proposal·stalled_report·measurement_only(게이트 키 없음)·accumulating(sample/기간 미달)·evidence_pending(sample+기간 충족). **promotion_proposal 생성 제거**(성과 검증은 CODEX-2) → "sample 단독 승격 금지"(C15) 완벽 준수. 판정상태는 **DB status(CHECK 5값) 미오염·출력 JSON(assessmentSummary)에만** 기록(매 평가 재계산 파생값). notify=halt/stalled로 제한. 검증(메티): 44종 분포 measurement_only 36/accumulating 7/evidence_pending 1/promotion 0·**position-lifecycle→measurement_only 정확 분류**·스모크 PASS(seedPreservesState·6상태 분기)·DB status 보존·tsc.
- **📊 evidence_pending 1호 = candidate-backtest-entry-gate**(sample 1081 ≥ minTrades 30) → CODEX-2 성과검증 첫 대상.
- **다음 (CODEX-2 보류)**: evidence_pending → 성과 게이트(signal_outcomes expectancy·virtualExpectancyDelta) → promotion 승격. evidence_pending 1종·성과 데이터 초기(C8 1건)라 **데이터 축적 후 진행**. 준비자료: `docs/codex/PREP_REGISTRY_PROPOSAL_SCHEMA_AUDIT.md`.

## ET-D 분석 + 구조 선구현 (2026-06-19, 메티 소스 실측·마스터 선택지1)
> "데이터 무관" 분류 정정 — 소스 실측으로 기존 자산 풍부 확인(이전 "태그 스키마 미존재" 추정 오류 시인).
- **3시장 적용**: 로직 3시장 공통(C3 청산 룰 시장 무관). reevaluator `binance`(crypto)/`kis`(국내) 거래소 분기(프레임/가중/임계)·**해외(미국주식) 거래소 미등록**(watchlist만). 실데이터 crypto 중심(보유 2·프로파일 binance 65/kis 1·신호 crypto 7/dom 1/ovs 0).
- **기존 자산 실측**: `position_strategy_profiles` 66행(setup_type·exit_plan·strategy_context)·reevaluator setup 청산 가드(`breakout_hold_guard`·`mean_reversion_profit_take`·`family_performance_protective_adjust`)·`familyPerformanceFeedback` 존재.
- **분류 불일치**: 현 setup_type(defensive_rotation 39·momentum_rotation 12·trend_following 7·micro_swing 5·breakout 2) vs C3(turtle/testah/range/defensive) → **매핑 필요**.
- **ET-D 구현 방향**: C3 정밀 청산 룰 평가기(10봉 최저 이탈 종가·75선 붕괴·구조 손절) shadow → 현 setup 가드와 가상 청산 성과 Δ 비교 → C15 등록. 거래소 컨텍스트 3시장 공통·실청산 0(reevaluator 동작 불변).
- **데이터 의존성**: 구조는 코드(지금)·의미 있는 비교는 C3 전략군 진입 포지션/신호 누적 후(현 crypto 신호 7건).

## P3 — 자율 완성
- C9 동적 리밋 · C10 워치리스트 · C12 일원화 · C13 ablation·라우팅 · C14 오토리서치·소스 · C16 add 승격 · Stage B/C · 파라미터 스토어 전면 소비 전환.

## 회의실 연동 구현(분담)
- 수시회의 트리거 ⑥서킷(T10 안건 표준)·⑦silent miss — P2 · ADR ID=evidence 상호 참조(P1-1 스키마) · debrief 미발화 행(G6 생성기) · 회의 결정 기한+미이행 재상정(P2).

## 무중단 체크리스트
- [ ] PROTECTED 미중지 · crypto LIVE·스카 무중단 · 신규 plist=비-PROTECTED · shadow 우선 · point-in-time/누수 차단.

## CODEX 순서 (현행화 2026-06-13)
✅ P0(6건)·P1(7건)·OPS_FIX·회의실 MR-A/B/C+FIX·UX개편·TOSS-A~D·ALPHA_FACTOR·L-소형 전부 완료.
- 다음 후보: L-P2a(C16 워치독·회의실 연동) ⭐ / L-P2b(C7 검증) / ALPHA-R5 승격(데이터+승인) / TOSS-E(승인) / 블로 B-B3검증.
- CLI 운영 인수인계: docs/codex/HANDOFF_CLAUDE_CODE_2026-06-13.md.


## 2026-06-19 ET-D 가동 + 회의실 L/P2d + reevaluator regime 수정 (메티 세션)

### ET-D 가동 (C3 전략군 청산 shadow)
- migration `luna_strategy_exit_shadow` + autopilot plist `LUNA_STRATEGY_EXIT_SHADOW=true`+confirm + reload. sidecar `void` fire-and-forget·**반환 불변**(reevaluator 결정/실거래 dispatch 무영향).
- 검증: 테이블·플래그·재등록 정상. 데이터 0 = 보유 포지션 0 + C3 매핑(breakout/trend_following→turtle·micro_swing→testah, defensive_rotation skip) 진입 대기.

### reevaluator regime lookup 버그 수정 (커밋 8184081aa)
- regime 스냅샷이 `'crypto'` 키로만 적재(`market_regime_snapshots` 3760행·`'binance'` 0행)인데 기존 `'binance'` 조회 → crypto regime **항상 null**(레짐 무시)이던 것을 `['crypto','binance']` 폴백 + `regimeKey=snapshot.market`으로 정상 인식.
- 실거래 dispatch/주문 로직 무변경·레짐 기반 청산/가중치 활성화 → **결정 변화 모니터링 권고**. (회의실 작업 중 발견)

### 회의실 L (⑥서킷 + debrief 생성기 + ADR 재상정) — 구현·가동·실검증
- 신규 `meeting-room-l-ops.ts`·`runtime-luna-meeting-room-l.ts`·smoke. `find*Candidates`(SELECT·중복방지 Set)→집계 회의·`canWrite`(confirm `luna-meeting-room-l-shadow`)·dryRun 기본.
- debrief 미발화=`regenerateMeetingMinutesMarkdown` 재사용·ADR 재상정=`evidence.mr_l.reagenda[]` append(status 직접 쓰기 0).
- launchd `ai.luna.meeting-room-l-ops`(30분·`--apply`) 가동. **실검증**: session 216 = circuit 10건→**1 adhoc 회의** 집계·재실행 중복방지 후보 0.

### L-P2d (수시회의 나머지 4트리거 + WS-I 리스크 훅) — 구현·가동·실검증
- 회의실 L ops 패턴 additive 확장: ②레짐 전환·④대형 공시·⑤일일 손실·WS-I 리스크 후보 수집 → eventAgendas 통합 → **단일 '수시 이벤트 점검' adhoc 회의** 1회(`runAdhocMeetingForAgendas`)·각 트리거 limit 20·중복방지. skip 플래그(`--skip-regime/disclosure/daily-loss/risk`).
- 기존 ⑥서킷/ADR/debrief/정기회의 흐름 무변경(additive)·산출 pending_master 제안만. **참고**: circuit이 eventAgendas에 통합돼 ⑥서킷도 '수시 이벤트 점검' 통합 회의의 일부가 됨(회의 난립 차단).
- **실검증**: session 219 = 이벤트 23건(disclosure 3+risk 20)→**1 회의** 집계·재실행 중복방지 후보 0·liveMutation false.

### ET-C (expected-fire 워치독 + debrief 미발화 편차 + 수시회의⑦) — 구현·검증 완료
- 신규 `luna-expected-fire-watchdog.ts`·`runtime-luna-expected-fire-watchdog.ts`·migration `20260619000006_luna_silent_miss_log`·smoke. shadow·관찰만(placed:false·실발화 0)·`canWrite`(confirm `luna-expected-fire-watchdog-shadow`)·dryRun 기본.
- **판정**: `lastReadyAt`(would-fire)+`fired_at` NULL+`terminalBlock`≠true+정상차단 화이트리스트 11종(`conditions_not_met`·`outside_binance_top30_volume_universe`·`duplicate_fire_cooldown`·`recent_executed_trade_cooldown`·`market_event_missing` 등) 제외+`detectExecutionMatch`(trade_journal/positions 매칭 없음)→silent miss. 회의실 ⑦=`findSilentMissMeetingCandidates`→eventAgendas 통합(읽기전용·`luna_silent_miss_log` 없으면 42P01 graceful·additive).
- **검증**: entry-trigger-engine 무변경(실발화 보존)·매칭 로직 확인·`scanned 0`(현 silent miss 0 = ready+미발화 전부 정상차단=시스템 건강). **메티 재현 오류 1건 자기수정**(화이트리스트 6종 재현→720h 24건 오탐 의심, 실제 코드 11종 확인→24건 전량 제외로 0 일치 확정·워치독 정상). 코드 cron 커밋 `ceb9eceba`.

### 다음 세션 예약
- **ET-C 활성화(마스터)**: migration `20260619000006_luna_silent_miss_log` apply + watchdog launchd 생성·활성화 + commit/push → 활성 후 메티가 실 silent miss 감지·회의실 ⑦ 통합 실검증.
- **ET-D 데이터 대기**: 매핑 가능 포지션(breakout/trend_following→turtle·micro_swing→testah) 진입 시 `luna_strategy_exit_shadow` 누적(현 보유 MEGA=defensive_rotation skip). reevaluator regime 수정 후 실거래 결정 변화 모니터링.
- (기타 트랙: Hub Week 2·블로 B3·Edu-X/Open DART Phase A 등 메모리 참조)


## 2026-06-19 구현 가능 목록 전수 분석 + 데이터 병목 정밀 진단 (메티 세션)

### ET-C 활성화 완료
migration `20260619000006` 적용·watchdog launchd(`ai.luna.expected-fire-watchdog`·30분) 가동·검증(scanned 0·written 0·placed 0·liveMutation false·회의실 ⑦ 읽기 정상). 현 silent miss 0(시스템 건강).

### 구현 상태 전수 맵
- **완료·가동**: P0 6/6 · P1 전부(C1 게이트·C2 레짐·C3 전략군·C4 사전게이트·C15 레지스트리·C17 파라미터 스토어) · 회의실 전부(MR·UX·L·수시회의 6트리거) · ALPHA(팩터·paper-mirror) · P2 C7 전면(permutation·CPCV·생존편향) · TOSS A~D · ET-A/C/D · C8 실가동
- **지금 구현 가능(데이터 무관·자산 존재)**:
  - **C17 제약 집행 강화**(S): P0-6 감사 결론은 "코드 변경 불필요"지만 권고 후속 미구현 — ①order_rules/paper_mode `block` 단언 smoke ②autonomous runner allowlist(`launchctl setenv`·plist edit·`--force` 차단). V-O 실사고(LLM 제약 우회) 대비 안전 핵심.
  - **C14 미구성 신호**(M): `luna-market-deployment-gate.ts`의 `vix_term_structure`·`put_call_ratio`·`btc_dominance`가 `not_configured` → 소스 연결로 C1 게이트 신호 완성(US 2/4·crypto 4/5). btc_dominance 우선(공개 API).
  - **C10 워치리스트 통합**(M): `runtime-luna-near-miss-watchlist.ts` 기존 → 전략군/ALPHA/레짐 후보 단일 뷰(M-6).
- **부분 가능(Stage/선행 의존)**: C6 LLM 강등(Stage B)·C9 add 액션(P3·실거래)·C13 재구성(P3)
- **데이터 대기**: C5(ALPHA IC)·C8 30거래(outcome 1)·ALPHA R5/R6·ET-B(armed 6)·ET-D(매핑 포지션)·promotion(evidence 1) — ※아래 병목 진단 참조
- **마스터 승인/지시**: TOSS-E(S2 micro-live)·argona AI 트레이딩 딥서칭

### 🔬 데이터 병목 정밀 진단 (핵심 — "데이터 부족"의 진짜 원인)
**시간 문제가 아니라 구조적 병목**:
- **근원: bear 레짐 + 추세 추종 전략만** — crypto가 6/12~6/19 지속 bear(bull 확률 1~4%·hmm dominant=bear). turtle/testah는 추세 추종(bull 필요) → 전략군 신호 8건 중 **7건 matched=false**(레짐 불일치·**정확한 동작**, 하락장에서 long 안 함), matched=true는 domestic bull 1건뿐.
- **하류 연쇄**: C8 outcome은 matched=true만 평가 → outcome 1건(win) → 30거래 규율 정체. ET-D도 매핑 포지션 진입 대기. C5도 입력 부족. **전부 레짐 병목의 하류 결과**.
- **진짜 구조적 병목 = bear/range장 전략군 부재**: C3에 turtle/testah(추세 추종)만 구현, **레인지 룰셋(v1.1 WB 더블 볼린저)·defensive·숏 미구현** → 하락/횡보장에서 진입 기회 0. 추세장만 기다리는 구조.
- 부차 병목: ALPHA 팩터 2개만 생성(게이트는 ok·생성기 빈도 낮음·후속 확인) · candidate_universe 16종목(domestic 9·overseas 6·crypto 1)이나 crypto 전략군 신호는 binance top-volume 별개 스캔(AVAX·SUI·NEAR 등).

### 💡 데이터 누적 해소책 (권고)
**레인지/defensive 전략군 추가(C3 v1.1 WB 더블 볼린저)가 데이터 누적의 키** — bear/range장에서 작동할 전략군이 생기면 matched=true 신호 증가 → C8 outcome·ET-D·C5 입력이 연쇄 누적. 단순 시간 대기보다 근본적. 전부 shadow·실발화 0 유지. (대안: crypto 숏 전략·ALPHA 생성기 빈도 점검)

### 다음 진입점 (갱신)
ET-C 활성화 완료. 선택지: ① 구현 가능 목록(C17 안전→C14 btc_dominance→C10) ② **레인지 전략군 추가**(데이터 병목 근본 해소) ③ argona 딥서칭(마스터 지시).


## 2026-06-19 생성 데이터 vs 실거래 데이터 정밀 대조 분석 (메티·추가 심층)

### 🔬 충격적 발견: 재설계 전략군이 실거래 수익 전략과 정반대·정렬 0
**두 개의 완전히 별개인 전략 체계가 병존**:
- **실거래(LIVE)**: `unified-analyst`·`strategy-router`·`strategy-family-classifier`·`regime-weight-learner` 생성 → momentum_rotation·mean_reversion·defensive_rotation. binance 691건 closed·**+$3,148 순익**·L4 autotune.
- **재설계 shadow**: C3 전략군(turtle_breakout/testah_pullback=추세 추종)·luna_strategy_signals 8건.

**① 방향 불일치(핵심)** — 전략군별 binance 실거래 수익:
| 전략 | closed | 승률 | 순익 | 재설계 |
|---|---|---|---|---|
| momentum_rotation | 395 | 12.4% | **+$1,786** | ❌ 없음 |
| mean_reversion | 150 | 18.0% | **+$1,401** | ❌ 없음 |
| trend_following | 17 | 17.6% | **−$20** | ✅ 집중 |
| breakout | 2 | 0% | **−$4** | ✅ 집중 |
| defensive_rotation | 48 | 18.8% | −$19 | 부분 |
→ 재설계가 집중하는 추세 추종(turtle/testah=trend_following/breakout)은 실거래에서 **손실**, 수익원(momentum/mean_reversion)은 재설계에 **부재**.

**② 정렬 0**: trade_journal signal_id 634건 NOT NULL이나 재설계 luna_strategy_signals 매칭 **0건** → 재설계 shadow는 실거래와 완전 별개.

**③ 실거래는 전 레짐에서 수익**: trending_bull +$1,763(414)·trending_bear **+$875**(111)·ranging **+$505**(89)·volatile +$4 → momentum/mean_reversion이 레짐 무관 작동(bear·ranging 포함). ※재설계 turtle/testah가 bear서 matched=false인 것과 대조 — 실거래는 같은 bear장에서 수익 중.

**④ 구성 정밀화**: cleanup 455건=정리거래(journal_reconciled_no_position 331·cutover 56·dust 13 등)·실전략 거래는 execution_origin=strategy 305건. autonomy_phase: **l4_post_autotune +$3,026(394) vs l4_pre_autotune +$123(227)** → autotune 효과 결정적.

### 💡 데이터 병목 해소책 (재정의·근본)
앞서 "레인지 룰셋 추가"보다 더 근본적: **재설계 C3 전략군을 실거래가 증명한 수익 전략(momentum_rotation·mean_reversion)으로 재정렬**. 이 전략 로직은 이미 `unified-analyst`·`strategy-router`·`strategy-family-classifier`에 구현됨(재사용 자산) → C3 shadow에 편입 시: ①재설계 신호가 실거래와 정렬 ②matched 증가 ③C8 outcome·ET-D·C5 데이터 연쇄 누적 ④shadow 비교(신구 스택)가 비로소 의미. 추세 추종(turtle/testah)만으론 실거래와 영원히 따로 놀고 bear/range장 데이터 0.

### 권고 우선순위 (갱신)
1. **C3 전략군 재정렬**(momentum/mean_reversion 편입) — 데이터 병목 근본 해소·실거래 정렬. 기존 자산 재사용.
2. C17 제약 집행 강화(안전·V-O). 3. C14 btc_dominance. 4. C10 워치리스트.
※주의: 실거래 LIVE(momentum/mean_reversion·+$3,148)는 무중단. 재정렬은 전부 shadow 비교로 검증 후 승격.


---

## 2026-06-20 ★자가발전 폐루프 복원 (Self-Evolution Loop) — 학습 단계 부활 ✅
> 커밋 `3bcbf8ab3 feat(luna): restore self-evolution loop` (main→origin/main, 작업트리 clean)

### 진단 (설계문서 §8-8)
- regime-weight-learner `7일 윈도우 × 3건 임계치` → 전 레짐 학습 영구 스킵 (snapshot 100개 가중치 Δ0, total_trades 0~1).
- strategy-router 학습값 미참조 (DB query 호출 0, 학습모듈 미import) → `buildRegimeBias` BASE 하드코딩만.
- = 자가발전 폐루프 **이중 단절**(학습 정지 + 적용 단절).

### 구현 (코덱스, bots/investment 6파일)
- regime-weight-learner: 기본 `30일` · 적응형 `30/60/90/180`(임계치 충족까지 확장) · `buildWeightDiagnostics`/`summarizeLearnerStall` 자가진단.
- strategy-router: `LUNA_LEARNED_BIAS_MODE` off|shadow|active(기본 off) · `±0.1` clamp · alpha 0.2 · fail-open · DI(`learnedWeightsProvider`).
- 신규 `luna-self-evolution-loop-smoke`(10 시나리오) · Phase-A smoke off/shadow 회귀 단언.

### 메티 독립검증 ✅ (자기보고 미신뢰·직접 재현)
- 정적: off 회귀0 · shadow scores불변 · active ±0.1 clamp · fail-open.
- smoke 10/10 PASS · Phase-A `ok:true` · tsc exit 0 · git diff --check clean · DB/plist/migration 없음.

### 학습 부활 실증 (kickstart -k, 2026-06-20 02:45)
- total_trades 0~1 → **BULL 87 · BEAR 5 · RANGING 4 · VOLATILE 3**(전 레짐 임계치 충족).
- TRENDING_BULL 가중치 자가조정: momentum 0.35→0.365 · breakout 0.30→0.313 · mean_reversion 0.15→0.115(상승장 모멘텀 강화).
- 적응형 90일 확장 작동 입증(BULL 87건 = 30일 윈도우론 2건 불가).
- 보수적 학습 정상: 샘플충분 BULL만 학습, 부족 레짐 BASE 유지.

### 폐루프 현황
- **학습 🟢 부활** / **적용 ⏸️ off**(`LUNA_LEARNED_BIAS_MODE` 미설정 = 거래영향 0).

### 다음 단계
1. 며칠 학습 누적 관찰(BEAR/RANGING 샘플 증가 → 학습 확대 확인).
2. `LUNA_LEARNED_BIAS_MODE=shadow`(plist, 마스터) → diff 관찰 → `active` 점진(α=0.2).
3. (후순위) 메타학습: 윈도우·임계치·learn_rate 성과 기반 자가조정 = 진정한 self-evolution.
> 코덱스 프롬프트: docs/codex/CODEX_LUNA_SELF_EVOLUTION_LOOP.md (완료 후 archive 이동 예정).


---

## 2026-06-20 (이어서) shadow 병행 + 자동승급 등록 설계 (메티)
> 마스터 결정: 관찰(1) + shadow(2) 병행 · shadow를 자동승급 시스템 등록까지

### 자동승급 시스템 파악
- `luna_component_registry`(44 컴포넌트, status=active 고정, 6-state 런타임 계산): component·current_mode·target_mode·promotion_criteria·sample_count.
- `luna-registry-seed.ts`(정의·idempotent) + `runtime-luna-registry-evaluator.ts`(EVIDENCE_QUERIES COUNT → proposalForRow 6-state → DB status 직접 미기재).
- 동형 패턴: strategy-router-phase-a-influence(diagnostic→shadow_bias), regime-expansion-shadow-sim, strategy-family-turtle/testah(virtualExpectancyDeltaPositive·evidence).

### learned-regime-bias 등록 설계(코덱스 프롬프트 작성 완료)
- registry-seed 추가: shadow→active_router_bias, criteria{durationWeeks 4·minSamplesPerFamilyRegime 30·virtualExpectancyDeltaPositive·evidence luna_regime_weight_snapshots}.
- evaluator EVIDENCE_QUERIES 추가: COUNT(*) FROM luna_regime_weight_snapshots WHERE total_trades>=3.
- 승급 흐름: shadow → sample 누적 → measurement_only→accumulating→evidence_pending → promotion 제안 → 마스터 검토 → active.

### 문서 정리
- 코덱스 프롬프트: `docs/codex/CODEX_LUNA_LEARNED_BIAS_AUTOPROMOTION.md`(신규).
- `docs/codex/CODEX_LUNA_SELF_EVOLUTION_LOOP.md` → `docs/codex/archive/` 아카이빙 완료(§8-8 구현 완료분).
- 설계문서 §8-9 추가.

### 대기(마스터)
1. 코덱스 [1][2] 구현(registry-seed + evaluator) → 커밋.
2. `luna-registry-seed` 실행(DB upsert — learned-regime-bias 등록).
3. `LUNA_LEARNED_BIAS_MODE=shadow` plist 추가(거래영향 0).
4. evaluator로 6-state 추적 → evidence_pending 시 promotion 제안 검토.

### 다음 진입점
- shadow 누적 관찰 + 자동승급 6-state 진행 모니터링.
- (후순위) virtualExpectancy 실측 evidence 정교화 · active 자동 적용 단계.
- 메타학습(윈도우·임계치·learn_rate 자가조정).


---

## 2026-06-20 적용 완료 ✅ (마스터 실행 + 메티 최종검증)
### seed/등록
- `runtime:luna-registry-seed` 실행: seeded=46, inserted=1(learned-regime-bias), updated=45.
- learned-regime-bias DB 등록 검증: current_mode=shadow, target_mode=active_router_bias, criteria{durationWeeks 4·minSamplesPerFamilyRegime 30·virtualExpectancyDeltaPositive·evidence luna_regime_weight_snapshots} 정상. registry active **46**(기존 45 무손상 = 회귀 0).
- evaluator 6-state: sampleCount=21 → **accumulating**(21/30 미달, 정합 재현).
### shadow 가동
- plist 2개(`ai.investment.runtime-autopilot`, `ai.luna.phase-a-shadow-15min`)에 `LUNA_LEARNED_BIAS_MODE=shadow` + launchctl last status 0. shadow 모드 = score/ranking/decision 변형 0(거래영향 없음).
- 미커밋: plist 2개(마스터 커밋 대기).

### 폐루프 최종 현황
- 학습 🟢 부활(적응형) / 적용 🟡 shadow 관찰(거래영향 0) / 승급 🟢 자동추적(accumulating 21/30).
- learned bias가 "수동 env 토글" → "증거 기반 자동승급 컴포넌트"로 전환 완료 = 루나 trading OS 자가발전 메커니즘 가동.

### 다음 진입점
1. 매일 07:00 학습 누적 → sampleCount 21→30 도달 시 evidence_pending → promotion 제안 알림.
2. promotion 제안 시 마스터 검토 → active 전환(수동 승인 유지, 1차 안전).
3. (후순위) virtualExpectancy 실측 evidence 정교화 · active 자동화 단계 · 메타학습(윈도우·임계치·learn_rate 자가조정).
