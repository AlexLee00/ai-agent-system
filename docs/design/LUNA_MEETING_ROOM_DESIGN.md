# 루나 일일 투자회의 + 펀더멘털 리서치 파이프라인 — 설계 (DESIGN)

> 버전 v0.1 (2026-06-08) · 작성: 메티 · 상태: 초안(마스터 검토 대기)
> SSOT. 변경 시 버전 갱신. 핸드오프: `docs/handoff/LUNA_MEETING_ROOM_HANDOFF.md`
> 불변·안전: 3역할 절차 / PROTECTED launchd 무중단 / crypto LIVE·스카 매출 무중단 / loopback+Tailscale / 자동 부작용 금지 / 부품 재사용 우선

## 1. 목적 · 범위 · 비목표

### 1.1 목적
- 매일 마스터가 의장(부재 시 루나)으로 참여하는 **국내주식 투자 회의(웹)**를 운영한다. 분석가 에이전트가 종목 선정·전략을 제시하고, 불·베어 토론과 리스크 심의를 거쳐 의장이 결정한다.
- 회의를 뒷받침하는 **펀더멘털 리서치 파이프라인**이 1차 자료(공시·재무·뉴스·수급) 기반 리포트와 내러티브를 생산해 RAG에 적재한다.
- 초기 보조(human-in-the-loop)에서 출발해 데이터·실적이 쌓이면 점진적으로 자율로 졸업한다.

### 1.2 범위 (Phase 1)
- 국내주식(KOSPI/KOSDAQ) · 모의주문(paper) · 웹 회의실 + 리서치 파이프라인 + 회의록(PostgreSQL/RAG).

### 1.3 확장 목표
- 국내주식에서 검증되면 **해외주식 → 암호화폐**로 확장. 기존 자산(`markets/overseas.ts`·`crypto.ts`, KIS 해외, 루나 crypto LIVE) 재사용. 확장은 §8 졸업 게이트 통과를 조건으로 한다.

### 1.4 비목표
- 즉시 LIVE 자동매매 · 자동 부작용(거래/이체/공시/통지) · 외부 대상 투자추천. LIVE·자금이동은 자율레벨과 무관하게 항상 별도 게이트.

## 2. 운영 정책 · 불변 원칙
- LLM 계층: 리서치/회의=Claude Code/OpenAI(클라우드, 이종 모델), LOCAL LLM=백테스트 전용.
- 출력: RAG(pgvector) + 리포트 파일(파일=감사·재현, RAG=회수·학습).
- 마스터 부재 시: 루나 의장 단독 회의 → 모의주문. LIVE는 async 승인(레벨 상승 시).
- 모든 고정값(라운드 수·임계·케이던스·비중 한도)은 설정으로 분리 → 추후 동적/자율 전환.
- 불변: 3역할 절차, PROTECTED launchd 무중단, crypto LIVE·스카 매출 무중단, loopback+Tailscale 전용, 자동 부작용 금지, 부품 재사용 우선(오케스트레이터만 신규).

## 3. 시스템 아키텍처

### 3.1 컴포넌트 개요
- **meeting-room 서비스** (`bots/investment/services/meeting-room/`)
  - `server/orchestrator`: 회의 세션 FSM + 발언자 선택 + 액션가드
  - `server/adapters`: 기존 파이프라인(L01~L34)·펀더멘털·주문·RAG 래핑 (신규 로직 X)
  - `server/minutes`: 회의록 작성 → PostgreSQL + RAG
  - `server/ws`: WebSocket(실시간 발언/상태)
  - `web`: React 회의실(2화면)
  - `config`: 회의 설정(라운드·임계·케이던스)
- **리서치 파이프라인**: 펀더멘털 데스크가 OpenDART/KIS/네이버/수급 데이터로 1차 자료 리포트+내러티브 생성 → `corp_*` 테이블 + RAG.
- **Hub (:7788, Express)**: 회의실 라우트 마운트, 인증(loopback+Tailscale), LLM 라우팅.
- **팀 제이 대시보드 (:7787)**: 회의실과 상호 링크 + 동일 PostgreSQL.

### 3.2 데이터 흐름 (일일 회의 1회)
1. (회의 전) 리서치 데스크 pre-read: 밤사이 공시·뉴스·가격 스캔 → morning-note 포맷 1차 자료 → RAG 적재
2. (회의) 안건 FSM: 시황 → 후보 → 분석(TA·감성·펀더멘털) → 불·베어 토론(이종 모델) → 리스크 심의 → 의장 결정(액션가드) → 회의록
3. (승인 시) 모의주문(l31 paper + kis-client) → 회의록·결정 PostgreSQL + RAG 적재
4. (사후) 체결·성과 추적 → reflexion/사후평가 → (Phase 2) CVRF 신념 갱신 → 다음 회의 컨텍스트

## 4. 레포 배치 · 재사용 매핑

### 4.1 신규 디렉터리
```
bots/investment/services/meeting-room/
  server/
    orchestrator/{meeting-session.ts, speaker-select.ts, action-guards.ts}
    adapters/{nodes-adapter.ts, fundamentals-adapter.ts, order-adapter.ts, rag-adapter.ts}
    minutes/   ws/   index.ts
  web/                      # React
  config/meeting.config.ts
bots/investment/launchd/ai.luna.meeting-room.plist     # 비-PROTECTED
bots/investment/migrations/2026xxxx_luna_meeting_room.sql
docs/codex/CODEX_LUNA_MEETING_ROOM_PHASE{1,2,3}.md
```

### 4.2 재사용 매핑 (신규 로직 금지 — 어댑터로 호출만)
- **토론**: `nodes/l11-bull-debate`·`l12-bear-debate`·`l11b-quant-debate`·`l12b-risk-debate` (이미 존재)
- **이종 모델**: `shared/dual-model-report`·`agent-llm-routing`
- **결정**: `nodes/l13-final-decision`·`l14-portfolio-decision`
- **주문(모의)**: `nodes/l31-order-execute`(paper) + `shared/kis-client`
- **RAG**: `nodes/l33-rag-store` / 회의록 적재
- **분석가**: `team/{aria,sophia,nemesis,luna,hanul,chronos…}`
- **자율·게이트**: `shared/{autonomy-phase,korea-data-promotion-gate,candidate-backtest-gate,guard-self-tuning,adaptive-cadence-resolver}`, `scripts/run-graduation-analysis`
- **데이터**: OpenDART(`ai.luna.opendart-*`) + `corp_fundamentals/disclosures/financial_reports`, `korean-factor-model`, `markets/domestic`
- **백테스트(로컬)**: `python/{finrl-x,quant,rl}`, chronos
- **안전**: `kis-market-hours-guard`, `VALIDATION_LANE_POLICY`

## 5. 회의 운영 모델

### 5.1 안건 FSM (8단계)
① 시황 → ② 후보 종목 → ③ 분석(TA·감성·펀더멘털) → ④ 불·베어 토론 → ⑤ 리스크 심의 → ⑥ 의장 결정 → ⑦ 회의록 → ⑧ 사후 추적 등록. 각 단계는 상태 전이 + 산출물(메시지/근거/결정)을 가진다.

### 5.2 발언자 선택
manual(의장=마스터 호출) / auto(루나 또는 team-router가 적합 에이전트 선택). 마스터 부재 시 루나 의장이 auto 진행.

### 5.3 토론 규칙
라운드 2 기본 / 최대 3(설정). 불=Claude · 베어=OpenAI(이종 모델, anti-monoculture). 조기합의 탐지(유사도 임계)로 거짓합의 차단. 각 발언=근거 인용 + 신뢰도 + 사실/추정 태그.

### 5.4 케이던스
일일 전술 회의(종목·진입) + 주간 전략 회의(포트폴리오·신념 갱신). `adaptive-cadence-resolver`로 추후 동적화.

### 5.5 에이전트 직접 질의
마스터가 @멘션/auto로 특정 에이전트에 질문 → A2A/`agent-message-bus` 라우팅 → 답변(출처+신뢰도+사실/추정) → RAG 적재. 회의 중/밖 모두. 답변發 액션은 액션가드 통과.

## 6. 회의실 UI

### 6.1 화면 ① 일일 회의실
헤더(자율레벨·의장·시장 상태) · 안건 스테퍼 · 참석 에이전트 · 발언 스트림(근거 칩·신뢰도·이종 모델 태그·조기합의 표시) · 의장 결정 액션가드 바(승인/수정/반려/보류) · 라이브 회의록 · 모의 포트폴리오.

### 6.2 화면 ② 에이전트 직접 질의
@멘션/auto 대상 선택 · 질문/답변 스레드(사실·추정 태그·신뢰도·근거) · "RAG 적재 + 답변發 액션은 승인 게이트" 표기.

### 6.3 통합
Hub Express(:7788)에 라우트 마운트(예: `/luna/meeting`). 팀 제이 대시보드(:7787)와 헤더 탭 상호 링크 + 동일 PostgreSQL(모의 포트폴리오·회의록은 `trade-journal`과 같은 소스 → 숫자 일관).

## 7. 펀더멘털 리서치 파이프라인

### 7.1 산출물
- **pre-read (morning-note 포맷)**: 밤사이 스캔(공시·뉴스·가격) → Top Call 헤드라인 + 우리 견해 + 후보(논거 + 촉매 + **반증조건**) → 1페이지.
- **종목 리포트**: 사업·밸류에이션·재무. 사실/추정 구분, 출처 tier.
- **의장 결정 메모 (ic-memo 경량)**: 요약(추천 + 핵심 리스크 3 + 미티건트) · thesis pillars · 시나리오 · 리스크(심각도×가능성) · **Proceed/Pass/Conditional + 조건**.

### 7.2 데이터
- 보유: OpenDART(공시·재무·XBRL) + `corp_*`, KIS(시세·체결), korean-factor.
- 갭(Phase 2): KRX 공식 시세/지수, 수급·외국인 5%·행동주의 공시, 네이버 금융 컨텍스트.
- 정합: **point-in-time**(as-of 스냅샷, 수정본 금지) + ingestion-lag/embargo → temporal-validity 메모리로 강제.

## 8. 자율 · 졸업 프레임워크

### 8.1 자율 레벨
L0(마스터 의장·전 결정 승인·학습) → L1(루나 의장·모의 자동·LIVE async 승인) → L2(저위험 자동·마스터 on-the-loop) → L3(완전 자율·범위 내).

### 8.2 이중 트랙 졸업 게이트
- **퀀트/RL 전략**: CPCV(purge+embargo·다중 경로 분포) + DSR/PBO + Minimum Track Record Length.
- **LLM 의사결정(회의/토론)**: 백테스트는 학습컷오프 누수로 불충분 → **post-cutoff forward(모의→라이브) 실적**으로만 졸업. + blindfold(익명화) 점검 + 이종 모델.
- 레벨 상승·모의→LIVE·시장 확장(해외/crypto)은 해당 트랙 통과를 조건으로 한다(`run-graduation-analysis` + `korea-data-promotion-gate` 재사용).

## 9. 정합 · 안전 가드

### 9.1 리서치 가드 (영상 G1~G10)
G1 시점 정합 · G2 사실/추정 태깅 · G3 출처 tier · G4 인용 · G5 양면(반증조건) · G6 N개 후속질문 · G7 판단 분리 · G8 컨텍스트 분기(새 대화 재검증) · G9 한 번에 한 질문 · G10 독립 재검증.

### 9.2 금융 가드
point-in-time/데이터 누수 차단 · 백테스트 과최적 방어(CPCV·DSR·PBO·MinTRL) · blindfold 검증 · 이종 모델(anti-monoculture) · **자동 부작용 금지(에이전트 헌법에 명문)**.

## 10. 학습 · 메모리
- **temporal-validity**: RAG 사실에 as-of+유효기간 → G1 강제.
- **CVRF (Phase 2)**: 에피소드 자기비판 → 투자 신념(자연어) → **해당 에이전트 노드에만 선택 전파**. reflexion/guard-self-tuning 위에 신념층.
- **napkin 실수노트 (Phase 2)**: 에이전트별 per-repo 마크다운 실수 기억 → 행동 전 회피. 시그마 오류루프 보강.
- 4-layer 메모리 정렬 + **async write**(회의 지연 방지) + dedup/노이즈 필터.

## 11. 커넥터 / MCP 전략
- 커넥터는 공용 레이어에 집중(기존 `shared/kis-client`·`opendart-*` 재사용), 회의실·파이프라인 공유.
- Phase 2 갭: KRX/수급/외국인·네이버 — `awesome-mcp-korea`의 vetted MCP를 포크/참조(라이선스 확인). **LIVE 주문 경로는 기존 KIS만**, 신규 MCP는 읽기 전용 우선.
- 시크릿: Hub secrets-store 경유. loopback+Tailscale 전용. 외부 MCP 도입 시 PROTECTED/LIVE 무중단 유지.

## 12. Phase 로드맵
- **Phase 1 (국내·모의)**: meeting-room 백엔드 + 오케스트레이터(안건 FSM) + 액션가드(autonomy-phase) + 회의록(PostgreSQL/RAG) + L01~L34/KIS 모의 어댑터 + 웹 스캐폴드. morning-note/ic-memo 포맷 · SKILL.md 컨벤션 · point-in-time/누수 규율 · 이종 모델 · 모의 forward 기록.
- **Phase 2 (학습·데이터·헤드리스)**: CVRF · napkin · CPCV+DSR/PBO 게이트 · KRX/수급/네이버 커넥터 · 대화형↔헤드리스 이중배포 · drift CI.
- **Phase 3 (자율·확장)**: 이중 트랙 졸업 게이트 자동화 · 완전자율 다이얼 · LIVE 확장 → 국내 검증 후 해외주식 → 암호화폐.

## 13. 리스크 · 미해결
- LLM 누수로 백테스트 신뢰 한계 → forward 실적 의존(시간 소요).
- 외부 MCP 도입 시 시크릿·안정성·라이선스 검토 필요.
- :7787 대시보드 통합 방식(임베드 vs 링크) 상세 확정 필요.
- CPCV 한국주식 적용(purge/embargo 파라미터) 별도 설계.
- 회의 LLM 비용(클라우드) 관리(`cost-tracker` 재사용).
- 미해결(시스템): n8n 자격증명, CalDigit 이더넷(WiFi 사용 중).
