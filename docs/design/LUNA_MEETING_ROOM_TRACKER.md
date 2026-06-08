# 루나 투자회의 — 구현 추적 (TRACKER)

> 버전 v0.2 (2026-06-08) · 작성: 메티 · 상태: Phase 1 착수 전 · SSOT=LUNA_MEETING_ROOM_DESIGN.md
> 항목: 작업 / 담당(코덱스·메티·마스터) / 상태 / 검증(문법·소프트·하드) / 의존성 / 연결 CODEX
> 원칙: 부품 재사용 우선(오케스트레이터만 신규) · PROTECTED/LIVE 무중단 · advisory 게이트(차단 X)

## Phase 요약
- **Phase 1(MVP)**: 회의실 백엔드+오케스트레이터(FSM)+advisory 액션가드+회의록(DB/RAG)+기존 노드/KIS 모의 어댑터+웹 스캐폴드+버튼/폴백. morning-note/ic-memo 포맷·point-in-time 규율·이종모델·모의 forward 기록.
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
- 일정: **이번 주=버튼 수동, 다음 주=폴백 정례화**

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

## 연결 CODEX 프롬프트
- Phase 1 → `docs/codex/CODEX_LUNA_MEETING_ROOM_PHASE1.md` (WS-A~E·G, **v0.3 통합 후 작성**)
