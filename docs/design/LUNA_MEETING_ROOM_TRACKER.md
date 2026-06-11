# 루나 투자회의 — 구현 추적 (TRACKER)

> 버전 v0.5 (2026-06-12) · 작성: 메티 · SSOT=LUNA_MEETING_ROOM_DESIGN.md(**v0.8**)
> 상태: **MR-A ✅**(백엔드·FSM·plan-note·ADR — WS-B/C/E 상당) · **MR-B ✅ 가동**(웹 7791 — WS-D/Q 상당) · **다음=MR-C**(정례화·텔레그램 원클릭·grill skill — WS-G+U2)
> **구현 진행의 SSOT는 `LUNA_OPTIMAL_REDESIGN_TRACKER.md` 종합 현황** — 본 트래커는 회의실 WS 정의·범위 참조용(이중 갱신 금지). 첫 공식 회의: 세션 #1·ADR 9건(2026-06-11).
> 항목: 작업 / 담당(코덱스·메티·마스터) / 상태 / 검증(문법·소프트·하드) / 의존성 / 연결 CODEX
> **⚠️ 우산 참조(2026-06-13)**: 루나 로직 재설계는 `LUNA_OPTIMAL_REDESIGN_TRACKER.md`가 상위 추적. WS-R/J/K/F/N/O/L/H는 그쪽으로 **합류**(이중 추적 금지) — 본 트래커는 **회의실(WS-A~E·G·Q)+WS-I/M/P 전용**.
> 원칙: 부품 재사용 우선(오케스트레이터만 신규) · PROTECTED/LIVE 무중단 · advisory 게이트(차단 X)

## Phase 요약
- **Phase 0(선행, 신규)**: **알파팩터 생성**(WS-R) — 후보 팩터→IC/RankIC→검증게이트(DSR/PBO/OOS)→마스터 게이팅→signal/skill 승격. **회의실보다 먼저.** SI 안전레일=별도 구축 제외(기존 가드 — kill-switch·24h 자동롤백·검증게이트 — 불변).
- **Phase 1(MVP)**: 회의실 백엔드+오케스트레이터(FSM)+advisory 액션가드+회의록(DB/RAG)+기존 노드/KIS 모의 어댑터+웹 스캐폴드+버튼/폴백. morning-note/ic-memo 포맷·point-in-time 규율·이종모델·모의 forward 기록. **알파팩터를 후보로 활용.**
- **Phase 2**: CVRF 신념층·temporal-validity·napkin·CPCV+DSR/PBO 리더보드·KRX/수급/네이버 커넥터.
- **Phase 3**: 졸업 게이트 자동화·자율 다이얼·LIVE 확장 → 검증 후 해외·암호화폐.

## 워크스트림 (WS-A ~ WS-H)

### WS-A. 백엔드 · Hub 연동 [Phase 1]
- A1 독립 loopback 서버 `services/meeting-room/server/index.ts`(웹+WS) — 코덱스 · 검증: 문법+기동(소프트) · 의존: 없음
- A2 Hub `hub-proxy` 프록시 경로(`/luna/meeting/*` → loopback) — 코덱스 · 의존: A1, hub-proxy.ts 존재 확인됨
- A3 migration `YYYYMMDDHHMMSS_luna_meeting_room.sql`(세션·회의록·paper 원장·발언로그) — 코덱스 · 검증: 적용+롤백(하드)

### WS-B. 오케스트레이터 [Phase 1] (신규 — 유일한 신규 로직)
- B1 `orchestrator/meeting-session.ts`(안건 8단계 FSM, 세션 상태기계) — 코덱스 · 검증: 단위 테스트
- B2 `orchestrator/speaker-select.ts`(manual/auto 발언자) — 코덱스
- B3 `orchestrator/action-guards.ts`(**advisory** — 차단 아닌 표시·점수; 실거래/자금이동만 경계) — 코덱스 · 검증: advisory 동작(하드)

### WS-C. 어댑터 [Phase 1] (기존 부품 래핑)
- C1 `adapters/nodes-adapter`(L01~L34 `node.run({sessionId,market,symbol})`, **L20 없음 주의**) — 코덱스 · 검증: 노드 호출 통과
- C2 `adapters/fundamentals-adapter`(OpenDART/KIS/korean-factor) — 코덱스
- C3 `adapters/order-adapter`(**paper 원장 DB**; LIVE 시만 l31+kis-client) — 코덱스 · 검증: 모의주문 원장 기록(하드)
- C4 `adapters/rag-adapter`(pgvector 색인/회수) — 코덱스

### WS-D. 웹 UI [Phase 1]
- D1 React 스캐폴드(네이티브 TS 재사용) — 코덱스
- D2 화면① 일일 회의실(안건 진행·참석·발언/토론·결정·회의록) — 코덱스
- D3 화면② 에이전트 직접 질의(@멘션) — 코덱스
- D4 :7787 대시보드 상호 링크 — 코덱스 · 의존: D1

### WS-E. 데이터 · 리서치 [Phase 1]
- E1 morning-note 포맷(밤사이→당일 브리프) — 메티 포맷 + 코덱스 구현
- E2 ic-memo 포맷(불/베어+과집중+"what makes this wrong") — 메티+코덱스
- E3 슬래시 액션 `/morning-note`·`/screen`·`/comps`·`/earnings`·`/thesis`·`/catalysts` — 코덱스

### WS-G. 회의 트리거 · 정례화 [Phase 1]
- G1 웹 "회의 시작" 버튼 → `POST :7788/luna/meeting/start`(+CLI adhoc) — 코덱스 · 검증: 세션 생성(하드)
- G2 `isKrTradingDay` 헬퍼(primary `isKisHoliday`, fallback `evaluateKisMarketHours`) — 코덱스 · 검증: 휴장일 판정 단위테스트
- G3 휴장일 버튼 비활성+팝업 — 코덱스 · 의존: G2
- G4 폴백 plist `ai.luna.meeting-room-daily-fallback`(hour=6, 거래일, 세션 없으면 시작) — 코덱스(메티 검토) · **비-PROTECTED**
- G5 폴백 plist `ai.luna.meeting-room-weekly-fallback`(weekday=0, hour=7, ISO주 세션 없으면) — 코덱스
- G6 [v0.6 신설] 국내 장후 debrief: plist `ai.luna.meeting-room-domestic-debrief`(16:00 국내 거래일) + **plan vs actual 대조표 생성기** + debrief-note(토론 0R·자율) — 코덱스 · 의존: G2 · 검증: 대조표 생성(하드)
- G7 [v0.6 신설] 미국 장전 점검: plist `ai.luna.meeting-room-us-premarket`(22:00 미 거래일) + `isUsTradingDay` 헬퍼(NYSE 캘린더·서머타임) — 코덱스 · 검증: 거래일 판정 단위테스트
- 일정: **이번 주=버튼 수동, 다음 주=폴백 정례화** · 장후/미장전=자율 모드 기본(§23.4)

### WS-F. 게이트 · 검증 [Phase 2]
- F1 CPCV(purge+embargo·multi-path) **신규** — 코덱스 · 검증: 합성데이터 단위테스트
- F2 DSR/PBO/MinTRL 리더보드(**advisory**, 비차단) — 코덱스
- F3 korea-data-promotion-gate 연동(post-cutoff forward 실적 기반 승급) — 코덱스

### WS-H. 학습 · 메모리 [Phase 2]
- H1 temporal-validity(사실 유효기간→시점정합) — 코덱스
- H2 CVRF 신념층(에피소드 자기비판→신념→필요 노드만 전파) — 코덱스
- H3 napkin 실수노트 · async write — 코덱스

## 재사용 vs 신규
- **신규(유일)**: WS-B 오케스트레이터 + 어댑터 래퍼 + 웹 + isKrTradingDay + migration + 폴백 plist 2개.
- **재사용**: 노드 L01~L34 · team/* · shared/*(kis-client·autonomy-phase·korea-data-promotion-gate·dynamic-position-sizer·execution-risk-and-capital·kis-market-hours-guard) · reflexion-engine · agent-memory-4layer · shadow-mode-runner · python/{finrl-x,quant,rl}.

## 무중단 체크리스트 (착수·검증 시 필수)
- [ ] PROTECTED launchd `ai.{ska,luna,investment,claude,elixir,hub}.*` 미중지
- [ ] crypto LIVE(루나) 무중단 · 스카 실매출 무중단
- [ ] 폴백 plist는 신규·비-PROTECTED (기존 plist 미수정)
- [ ] paper 원장만 사용(LIVE는 마스터 다이얼 시에만)
- [ ] point-in-time/누수 차단 유지(계측 진실성)

## 시장 확장 게이트 (Phase 3)
- 국내주식 forward 실적(post-cutoff) + CPCV 리더보드 통과 → 해외주식(KIS 해외·markets/overseas) → 암호화폐(루나 crypto LIVE·markets/crypto).
- 각 단계 = 마스터 다이얼 승인 경계.

## 연결 CODEX 프롬프트 (순서)
- **1번 → `docs/codex/CODEX_LUNA_ALPHA_FACTOR.md`** (WS-R 알파팩터 — 회의실 선행, 검증게이트 위)
- 2번 → `docs/codex/CODEX_LUNA_MEETING_ROOM_PHASE1.md` (WS-A~E·G)
- (보류) WS-I~Q(v0.3 보강) · SI 정렬 — 성장·검증 누적 후 선택

## 워크스트림 — v0.3 보강 (WS-I ~ WS-Q) [Phase 2~3]
> 코드 대조 결과(LUNA_BOOST_APPLY_REVIEW): 대부분 **활성화/확장**, 신규 소수. 활성화=마스터 게이팅(검증 후 단계 ON).

### WS-I. 리스크 훅 [Phase 2] (B-13) — 경계
- HWM(고점자본) 영속(**신규 선결**) → `checkCircuitBreaker` peak-drawdown 체크#4 → **kill-switch 연동**(기존 `luna-kill-switch-consistency` 확장) → l31-order-execute 진입 차단 → correlation(advisory 감산).
- 담당: 코덱스 / 의존: HWM 선결 / 검증: 트리거·수동해제·l31 abort / 활성화: `max_peak_drawdown_pct`+env.

### WS-J. 레짐 정밀화 [Phase 2] (B-10·B-12) — shadow→active
- 경험적 전이행렬(`regime-weight-learner`+`luna_regime_weight_snapshots` 재사용) + HMM 상태수 자동선택(BIC)·forward 필터·안정성 필터 → `LUNA_HMM_REGIME_ENABLED` 활성화.
- 의존: phase-a shadow 검증 / 활성화: env+promotion-gate.

### WS-K. 검증 활성화 [Phase 2] (B-16·B-18) — advisory(승급)
- **RST 신규**(랜덤 엔트리 p-value) + **PBO 게이트 배선**(DSR 미러) + 캘리브레이션(Brier) + MC 2종 확인 + 레짐 OOS → env 활성화(`..._ENTRY_GATE_MODE`·`LUNA_DSR_GATE_ENABLED`·`LUNA_PBO_GATE_ENABLED`).
- 재사용: candidate-backtest-gate·monte-carlo·stress-test.

### WS-L. 자기개선·ADR [Phase 2] (B-01·B-05·B-06·B-17)
- 단일변수 실험원장(신규) + ADR 메타로그(JSONB 이벤트 스토어 재사용) + scorer 목표대비(calcSelfReward 확장) + reflexion→skill 갱신(posttrade-skill-extractor 확장).
- 의존: B-18 검증 게이트(darwin proof-r apply 전제).

### WS-M. 스킬 [grill=**Phase 1 승격**(자율 회의 전제, §23.5) · 나머지 Phase 2] (B-02·B-03·B-17)
- glossary/grill skill 신규(`skills/luna/` 패턴 재사용·agentskills.io 포터블) + self-evolving 연결 + 전략 템플릿(선택).

### WS-N. 수급 활성화 [Phase 2] (B-19)
- OpenDART 키(secrets-doctor)+`LUNA_DISCOVERY_DART` 활성화 → disclosure-event(5%/내부자/행동주의) Research 신호 + 외국인/기관 순매수(KRX 수급) 어댑터(신규).
- 재사용: opendart_client·dart-disclosure-collector·disclosure-event-driven(A2A).

### WS-O. 출구·사이징 [Phase 2] (B-11·B-20)
- 트레일링 활성화(`shouldApplyDynamicTrail` 모드 점검 — **기구현**) + 래더 엔트리(신규·B-13 한도 준수) + conviction 사이징(`dynamic-position-sizer`에 P(bull)−P(bear) 입력).
- 의존: B-12 안정성 필터(conviction) · B-13 한도(래더).

### WS-P. 비용·컨텍스트 [Phase 2] (B-08·B-15)
- 예산가드 회의/사이클 확장(`ensureDailyEvaluationBudget` 패턴) + per-message 비용 로그 + 컨텍스트 예산/RAG top-k 상한. advisory(하드정지=경계).

### WS-Q. 회의 UI·단일창구 [Phase 1~2] (B-07·B-09)
- meeting-room agent-view(A2A Task 상태) + needs-input 큐(input-required=마스터 승인) + 단일 창구(`orchestrate`/Hub 재사용).
- 재사용: A2A multi-agent-coordination·orchestrate.

## 재사용 vs 신규 — v0.3 보강
- **신규(net-new)**: HWM·correlation·RST·PBO 게이트·경험 전이행렬·HMM 정밀화·캘리브레이션·conviction 입력·단일변수 원장·ADR 메타·래더·외국인수급 어댑터·glossary/grill skill·meeting-room UI.
- **활성화(env/flag)**: DSR 게이트·HMM 레짐·adaptive weight·OpenDART·dynamic-trail·entry-gate mode.
- **확장**: 회로차단기·sizer·scorer·skill-extractor·예산가드·coordination.

## 워크스트림 — v0.4 성장 (WS-R) [Phase 0 — 회의실 선행]
> 방침(마스터): **알파팩터 → 회의실** 순서. SI 안전레일 별도 구축 제외(기존 가드 불변). 상세=DESIGN §20·LUNA_GROWTH_REINFORCEMENT(LG-01).

### WS-R. 알파팩터 생성 [Phase 0] (LG-01) — 로직 성장 핵심
- R1 팩터 생성기(LLM Chain-of-Alpha 이중체인 또는 RL AlphaGen식, **local 우선**·소규모 예산) — 코덱스 · 검증: 후보 팩터 생성(소프트)
- R2 IC/RankIC 평가 모듈 — 코덱스 · 검증: 지표 산출 단위테스트
- R3 `candidate-backtest-gate` 검증 연결(DSR/PBO/OOS) — 코덱스 · 검증: 게이트 통과 판정 / **재사용**(기구현)
- R4 팩터=**실행가능·감사가능 코드** 저장 + shadow 기록 — 코덱스 · 검증: 저장·재현
- R5 마스터 게이팅 → 통과분 `signal`/`skill` 승격 — 코덱스(메티 검토) · advisory(승격, 검증 없는 승격 금지)
- R6 회의실 연결: 승격 팩터 → Research 레인 입력(회의 후보) — 코덱스 · 의존: 회의실 Phase 1
- 의존: `candidate-backtest-gate`(기구현) · `discovery` · `skills/luna` / **안전: 기존 게이트 경유(신규 안전레일 없음)** / 무중단: shadow→승격

## 재사용 vs 신규 — v0.4 성장(WS-R)
- **신규**: 팩터 생성기(LLM/RL) · IC/RankIC 평가 · 팩터=감사가능 코드 저장.
- **재사용**: `candidate-backtest-gate`(검증) · `discovery`(유니버스) · `skills/luna`(승격 대상) · shadow 인프라.
- **제외**: SI 안전레일 신규 트랙(기존 kill-switch·24h 자동롤백·검증게이트로 충분).
