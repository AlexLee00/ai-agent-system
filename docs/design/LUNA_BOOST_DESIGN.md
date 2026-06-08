# 루나팀 보강안 상세 설계 (BOOST DESIGN)

> 작성: 메티 · 2026-06-08~ · 상태: 작성 중 · 입력=LUNA_VIDEO_REINFORCEMENT.md(B-01~B-20) + 기술 서베이
> 목표: B-01~B-20 각각을 **소스코드 딥분석 + 최신 기술(Skills·Hooks·MCP·A2A·Workflows) 적용·최적화 + 외부 베스트프랙티스** 기반 구현 가능 보강안으로. → DESIGN/TRACKER v0.3 통합 → Phase 1 CODEX.
> 원칙: 부품 재사용 우선 · advisory 게이트(차단=경계만) · PROTECTED/LIVE 무중단 · 3역할.

## §1. 기술 서베이 (전 보강안 공통 입력)

### 1.1 Skills (Anthropic + Codex, agentskills.io 공통 표준)
- **anthropics/skills**(공식·Apache2.0): SKILL.md(지시+메타) 폴더, 동적 로드, **progressive disclosure**(이름/설명/경로 먼저 → 사용 시 본문). Claude Code 플러그인 마켓플레이스(`/plugin install …@anthropic-agent-skills`), Skills API. **mcp-builder 스킬**(MCP 서버 생성)·docx/pdf/pptx/xlsx·web-artifacts.
- **Codex Skills**(2025-12~): `~/.agents/skills/SKILL.md` **동일 포맷** → **Claude Code ↔ Codex 포터블**. 플러그인(skills+MCP+app, `.codex-plugin/plugin.json`), `$skill-installer`, config.toml.
- **루나 적용**: 도메인 절차/전략/용어를 **SKILL.md로 패키징**(B-02 CONTEXT.md=glossary skill, B-03 grill skill, B-17 self-evolving skill, 전략 템플릿 skill). 메모리 `packages/core/lib/skills`·시그마 A2A Skills 12개 재사용. 메티→코덱스(Claude Code/Codex) 동일 스킬.

### 1.2 Hooks (Claude Code 12~21 이벤트 + Codex `codex_hooks`)
- 이벤트: **PreToolUse**(실행 전, exit 2=차단/거부), **PostToolUse**(사후, 검증/포맷/로그·undo 불가), SessionStart(컨텍스트 주입), Stop(exit 2=계속), SubagentStop, UserPromptSubmit.
- 핸들러 4종: **command**(셸) · **http**(엔드포인트 POST) · **prompt**(경량 LLM 평가) · **agent**(서브에이전트 검증). `async:true` 비차단. `.claude/settings.json`. JSON stdin(tool_name·tool_input·tool_response).
- 핵심=**결정론적 강제**("프롬프트 요청이 아니라 보장된 실행" — 모델이 못 잊고 못 건너뜀).
- **루나 적용**: **B-13 회로차단기=PreToolUse 훅**(주문 도구 차단, drawdown 한도 hit 시 exit 2 → "하드코딩·모델독립 veto"의 정확한 구현). **B-05 스코어러/B-18 검증=PostToolUse 훅**(매 결정 점수화·로그→CVRF, async). **point-in-time 누수=PreToolUse**(미래데이터 접근 차단). **우리 advisory 가드=prompt 핸들러**(경고 stderr+exit 0, 비차단). SessionStart=회의 시작 시 메모리/RAG 주입(stateless-wake).

### 1.3 A2A (Agent2Agent, Linux Foundation, v1.0 2026)
- **Agent Card**(`/.well-known/agent-card.json`: 능력·엔드포인트·인증·메타, v1.0 **서명**) · **Task 라이프사이클**(submitted→working→**input-required**→completed/failed/canceled) · Message(user/agent) · Artifact. HTTP+SSE+JSON-RPC(+gRPC). MCP(수직·도구)와 **상보**(수평·에이전트).
- **루나 적용**: 메모리 "A2A Skills 12개"와 정합. **Task 라이프사이클 = B-09 에이전트 상태/needs-master-input 모델 표준**(input-required=마스터 승인점). **Agent Card = 6레인 에이전트 능력 광고·위임**(Argos/Aria/Nemesis/Luna/Hanul/Chronos). 외부 에이전트(저스틴 등) 통합 시 표준. (전 내부 시스템이라 서명·멀티벤더는 선택.)

### 1.4 MCP (도구 접근 — 기존 서베이 + 신규)
- **mcp-builder 스킬**(anthropics)로 루나 전용 MCP 서버 생성. Codex-as-MCP(코덱스를 도구로 호출). 
- 금융/데이터 MCP(기 서베이): TradingView MCP(데이터형만 보조·CDP 제어형 보안/ToS 비채택), korea-stock-mcp(DART+KRX)·korea-stock-analyzer(수급/DCF)·네이버. **agent-cost-mcp**(비용 추적·예산경보·대시보드→B-08), **brain MCP**(SQLite 영속 메모리).
- **루나 적용**: meeting-room 독립 loopback(결정②)을 Hub `hub-proxy` 경유 노출. 데이터 어댑터(OpenDART/KIS)·B-19 수급/공시 소스. mcp-builder로 표준화.

### 1.5 Codex 오케스트레이션 / 워크플로우
- **Agents SDK 멀티에이전트**: PM 에이전트(REQUIREMENTS/TEST/AGENT_TASKS.md 작성)→설계/구현/테스트 에이전트 hand-off + **guardrails** + **Traces**(매 프롬프트·tool-call·hand-off 기록→대시보드 감사).
- Codex 슬래시(/review·/fork·/side·커스텀), 서브에이전트, AGENTS.md(=CLAUDE.md 대응), Codex Security(취약점).
- **루나 적용**: **Traces = 회의록 + B-01 ADR + 관측성**(매 lane hand-off 감사). PM 에이전트=Luna 오케스트레이터, hand-off=lane 전이, guardrails=advisory 게이트. compound-engineering/multi-agent 워크플로우 패턴 차용.

## §2. 보강안 작성 프레임 (각 B-항목 공통)
각 항목: **① 소스코드 딥분석**(실측 파일·계약) → **② 적용 기술**(§1 매핑) → **③ 외부 베스트프랙티스** → **④ 최적화 제안**(재사용·advisory·무중단) → **⑤ v0.3 반영 + WS/CODEX 연결**.

## §3. 우선순위
- **강력권장 6** (이번 세션 우선): B-01 ADR · B-06 단일변수 자기개선 · B-10 Markov 레짐 · B-12 레짐 정밀화 · B-13 회로차단기 · B-18 검증 3종.
- **권장 12**: B-02·B-03·B-05·B-07·B-08·B-09·B-11·B-15·B-16·B-17·B-19·B-20.
- **참고/선택**: B-04·B-14·전략 템플릿·도구 패턴.

---
## §4. 강력권장 보강안 (상세)

### B-13. 리스크 회로차단기 — 하드코딩·모델독립 veto [강력권장]
**① 소스코드(실측)**: `shared/capital-manager.ts:704 checkCircuitBreaker(exchange,tradeMode)` → `{triggered,type,reason}`. 현재: ① 일간손실(`policy.max_daily_loss_pct`) ② 주간손실(`max_weekly_loss_pct`) ③ 연속손실 쿨다운(`cooldown_after_loss_streak`/`cooldown_minutes`). **dev 완화**(`getCryptoGuardSofteningPolicy`→`softened:true`+`reductionMultiplier`) = 우리 "가드 최소" 철학이 이미 코드화. `preTradeCheck`가 호출→`{allowed,circuit,circuitType}`. 인접: risk-approval-chain/mode/execution-guard + `shared/quant/{monte-carlo,stress-test}.ts`(`killSwitchWouldTrigger`).
**② 적용 기술(§1.2 Hooks)**: 현 checkCircuitBreaker는 **앱 경로**(에이전트가 preTradeCheck 호출해야 작동)→모델이 건너뛸 여지. **PreToolUse 훅 승격**: order-execute(L31)/order-adapter 도구 호출 전 훅이 회로차단+halt 평가→`exit 2`=차단(stderr=사유). = 영상의 "하드코딩·모델독립 veto" 정확 구현(모델이 못 잊고 못 건너뜀).
**③ 외부 베스트프랙티스**: 영상 임계값(일 −2%→반감/−3%→청산·주 −5%→반감·**peak −10%→중단**) + correlation 체크(기존 포지션 상관) + López de Prado 자본보존. block-file=수동 재개.
**④ 최적화 제안**:
- **신규 peak-drawdown halt**: `policy.max_peak_drawdown_pct`(기본 0.10) 추가 → 트리거 시 `{type:'peak_drawdown',halt:true}` + **block 파일**(`state/luna-halt.lock`) 기록. preTradeCheck/훅이 lock 존재 시 전량 차단. **lock 삭제=마스터 명시 행동**("실거래=마스터" 정합). dev 완화 **미적용**(=경계).
- **신규 correlation 체크**: preTradeCheck에 기존 오픈포지션 vs 후보 상관 임계 초과 시 차단(Nemesis 노출/과집중, B-19 수급과 연계).
- **재사용**: 일/주/연속손실 + 완화 정책 그대로 · monte-carlo/stress-test killSwitch 임계 정합.
- **advisory vs 경계 구분**: 일/주/streak=완화 가능(절차 마찰) · **peak-drawdown halt=하드 veto(되돌릴 수 없는 손실=경계, 비완화)**.
**⑤ v0.3/WS**: DESIGN §3 가드 "경계"에 peak-drawdown halt 명시 · 신규 **WS-I(리스크 훅)**: capital-manager에 `max_peak_drawdown_pct`+correlation, order 도구 PreToolUse 훅, halt-lock 수동 재개. CODEX: 기존 checkCircuitBreaker **확장**(신규 로직 최소). 검증: 하드/소프트 트리거 + lock 재개 테스트.
