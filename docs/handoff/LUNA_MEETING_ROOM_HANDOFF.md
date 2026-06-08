# 루나 일일 투자회의 — 세션 핸드오프 (2026-06-07)

> 작성: 메티 · 상태: **설계 합의 완료, 문서화 대기**
> 다음 세션 과업(순서 고정): ① 설계 문서 → ② 추적 문서 → ③ Phase 1 CODEX 프롬프트
> 3역할: 메티 작성 → 마스터 검토·커밋. 프롬프트는 설계·추적 확정 후 착수.

## 0. 다음 세션 액션 플랜
1. `docs/design/LUNA_MEETING_ROOM_DESIGN.md` 작성 (SSOT, §3 목차대로)
2. `docs/design/LUNA_MEETING_ROOM_TRACKER.md` 작성 (PLATFORM_IMPLEMENTATION_TRACKER 패턴, §4 구조대로)
3. `docs/codex/CODEX_LUNA_MEETING_ROOM_PHASE1.md` 작성

## 1. 목적 · 범위 · 비목표
- 목적: 국내주식 **일일 투자회의(웹)** + **펀더멘털 리서치 파이프라인**. 보조(human-in-the-loop) → 점진 자율.
- **목표(신규): 국내주식에서 검증되면 해외주식·암호화폐로 확장.** (기존 자산 markets/{overseas,crypto}.ts · KIS 해외 · 루나 crypto LIVE 활용. 자율 졸업 프레임과 연동: 국내 검증 → 시장 확장.)
- 비목표: 즉시 LIVE 자동매매 · 자동 부작용(거래/이체/공시) · 외부 투자추천.

## 2. 확정 결정 원장
### 운영 정책
국내주식 우선(→해외·암호화폐 확장) · 보조 · 리서치/회의 LLM=Claude Code/OpenAI(클라우드) · LOCAL LLM=백테스트 전용 · 출력=RAG(pgvector)+리포트 파일 · 마스터 부재 시 루나 단독=모의주문(→LIVE 확장) · 고정값→동적/자율 지향

### 아키텍처 위치
루나팀=`bots/investment` · 회의실=`bots/investment/services/meeting-room/`(server/orchestrator·adapters·minutes·ws + web + config) · `launchd/ai.luna.meeting-room.plist`(비-PROTECTED) · `migrations/…luna_meeting_room.sql` · Hub Express(:7788) 라우트 마운트

### UI
전용 웹, 스택=R(네이티브 TS 재사용, Magentic-UI는 참고만/fork X) · 화면 2종(① 일일 회의실 ② 에이전트 직접 질의) · 팀 제이 대시보드 :7787 연동(상호 링크 + 동일 PostgreSQL)

### 회의 운영
안건 8단계 FSM · 의장=마스터(부재 시 루나) · 발언자 manual/auto · 토론 2R 기본/cap 3 + 이종 모델(불=Claude/베어=OpenAI) + 조기합의 탐지 · 케이던스=일일 전술 + 주간 전략

### 자율 · 졸업
L0(마스터 의장·전결정 승인)→L1(루나 의장·모의 자동·LIVE=async 승인)→L2(저위험 자동·on-the-loop)→L3(완전자율) · 이중 트랙 졸업 게이트: 퀀트/RL=CPCV+DSR/PBO/MinTRL · LLM 의사결정=post-cutoff forward 실적(백테스트는 필터지 증명 아님)

### 데이터 · 커넥터
보유: OpenDART(Hub 키)·KIS·korean-factor · 갭 후보: KRX 공식 시세/지수, 수급·외국인 5%·행동주의 공시, 네이버 금융 컨텍스트

### 학습 · 메모리 · 정합 가드
CVRF(에피소드 자기비판→투자신념→해당 노드만 전파) · temporal-validity(사실 유효기간 저장→G1 시점정합 강제) · napkin 실수노트 · async write · 4-layer 메모리 정렬 · 가드 G1~G10(영상) + 금융(point-in-time/누수·CPCV·DSR/PBO/MinTRL·blindfold·이종모델·자동부작용 금지)

## 3. 설계 문서 목차 (LUNA_MEETING_ROOM_DESIGN.md)
1 목적·범위·비목표 · 2 운영정책·불변원칙 · 3 시스템 아키텍처(컴포넌트·데이터 흐름) · 4 레포 배치·재사용 매핑 · 5 회의 운영 모델(안건 FSM·발언자·토론·케이던스) · 6 회의실 UI(2화면·:7787 연동) · 7 펀더멘털 리서치 파이프라인(데이터·morning-note/ic-memo 포맷) · 8 자율·졸업(L0~L3·이중트랙 게이트) · 9 정합·안전 가드(G1~G10+금융) · 10 학습·메모리(CVRF·temporal-validity·napkin) · 11 커넥터/MCP 전략 · 12 Phase 로드맵(국내→해외→crypto) · 13 리스크·미해결

## 4. 추적 문서 구조 (LUNA_MEETING_ROOM_TRACKER.md)
- Phase(1/2/3) × 워크스트림(백엔드·오케스트레이터·어댑터·웹·데이터·게이트·학습) 표
- 항목별: 작업 / 담당(코덱스·메티·마스터) / 상태 / 검증기준(문법·소프트·하드) / 의존성 / 연결 CODEX 프롬프트
- 별도 섹션: 재사용 vs 신규 구분 · PROTECTED/LIVE 무중단 체크리스트 · 시장 확장(해외·crypto) 게이트 조건

### Phase 요약(초안)
- Phase 1: meeting-room 백엔드+오케스트레이터(안건 FSM)+액션가드(autonomy-phase)+회의록(PostgreSQL/RAG)+기존 L01~L34/KIS 모의 어댑터+웹 스캐폴드. morning-note/ic-memo 포맷·SKILL.md 컨벤션·point-in-time/누수 규율·이종모델·모의 forward 기록.
- Phase 2: CVRF 학습층·napkin 실수노트·CPCV+DSR/PBO 게이트·KRX/수급/네이버 커넥터·이중배포(헤드리스) 구조·drift CI.
- Phase 3: 이중 트랙 졸업 게이트 자동화·완전자율 다이얼·LIVE 확장 → 검증 후 해외주식·암호화폐 확장.

## 5. 재사용 자산 (신규 최소화)
`nodes/l01~l34`(**l11/l12 불·베어 토론 보유**) · `team/{aria,sophia,nemesis,luna,hanul,chronos…}` · `shared/{kis-client,autonomy-phase,korea-data-promotion-gate,candidate-backtest-gate,guard-self-tuning,adaptive-cadence-resolver,dual-model-report}` · `scripts/run-graduation-analysis` · reflexion-engine · `agent-memory-4layer` · `python/{finrl-x,quant,rl}` · `skills/{karpathy-self-check,shadow-mode-runner}` · 백테스트 마이그레이션(DSR/PBO/OOS/walk-forward/meta-label) — **CPCV만 갭**

## 6. 외부 레퍼런스 (재조사 불필요)
- **anthropics/financial-services**: SKILL.md 컨벤션·morning-note·ic-memo·대화형↔헤드리스 이중배포(L0↔L3)·sync/check.py drift CI
- **프레임워크**: TradingAgents(불/베어/리스크/펀드매니저+reflection)·FinCon(manager-analyst+CVRF)·FinMem(layered memory)·FinRobot
- **한국 MCP**: darjeeling/awesome-mcp-korea · jjlabsio/korea-stock-mcp(DART+KRX) · korea-stock-analyzer-mcp(재무·기술·DCF·뉴스·수급) · KIS MCP · 외국인5%/행동주의 MCP · Naver Finance skill
- **메모리**: Mem0/OpenMemory MCP(local·async·dedup) · Letta(tiered) · Zep/Graphiti(temporal validity)
- **스킬**: VoltAgent/awesome-agent-skills(20k★) · ComposioHQ/awesome-claude-skills · napkin(실수노트) · karpathy-self-check(보유)
- **금융 rigor**: 룩어헤드/누수(AI Hedge Fund 붕괴 사례) · DSR/PBO/CPCV(López de Prado) · LiveTradeBench/StockBench · BlindTrade(한국대+미래에셋)

## 7. 불변 · 안전
3역할 절차 · PROTECTED launchd(ai.{ska,luna,investment,claude,elixir,hub}.*) 무중단 · crypto LIVE·스카 매출 무중단 · loopback+Tailscale 전용 · 자동 부작용 금지 · 부품 재사용 우선(오케스트레이터만 신규)

## 8. 참고 세션 산출물
- 트랜스크립트: `2026-06-07-22-54-59-luna-meeting-room-design`
- UI 목업 2종(회의실/직접질의) · 영상 분석(youtu.be/fVXtAgIjM3E) G1~G10 · financial-services 딥분석(morning-note/ic-memo)
