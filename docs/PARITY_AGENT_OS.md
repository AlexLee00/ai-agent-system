# Agent OS Parity Matrix

> 작성: Codex
> 작성일: 2026-04-03
> 목적: Agent OS의 설계, 구현, 파이프라인 연결, 운영 검증 상태를 한눈에 관리
> 상태: living document

---

## 범례

- `yes`: 설계/구현/연결/검증이 완료됨
- `partial`: 일부 구현되었거나 연결은 됐지만 운영 검증이 제한적임
- `no`: 아직 없음

---

## 도메인별 매트릭스

| Domain | Design | Implemented | Pipeline | Ops Verified | Known Limits |
|--------|--------|-------------|----------|--------------|--------------|
| Agent registry | yes | yes | yes | yes | team rename/history consistency can still drift in old records |
| Hiring contracts | yes | yes | yes | yes | some team aliases and specialty weighting remain heuristic |
| Trace collector | yes | yes | yes | yes | selection trace for chosen skill/tool is not stored yet |
| Team tracking JSONB | yes | yes | partial | yes | old string-style `analyst_signals` still exists in 일부 경로 |
| Skill registry | yes | yes | yes | yes | workflow skills were not connected before this phase |
| Tool registry | yes | yes | yes | partial | auto-execution is still gated; planning is stronger than execution |
| Team skill selector | yes | yes | yes | yes | preference learning is still score-based, not full contextual routing |
| Team tool selector | yes | yes | yes | yes | cost and latency learning is basic, not adaptive per project |
| Team skill→MCP pipeline hook | yes | yes | yes | yes | recommend/build-plan only; real MCP auto-run is still limited |
| Workflow skills | yes | yes | partial | partial | newly added in this phase; team insertion points still need rollout |
| Browser runtime | yes | partial | partial | yes | persistent browser manager is not yet standardized as one runtime |
| Worker agent office | yes | yes | yes | yes | some visuals are customized but operational parity traces are absent |
| Blog competition | yes | yes | partial | partial | scheduled path exists, but production stability depends on content pipeline health |
| Luna shadow hiring | yes | yes | yes | partial | evaluation is connected, but broader strategy-combo analytics are still shallow |
| Darwin leader team | yes | yes | yes | partial | workflow integration and deeper E2E samples still needed |
| Justin leader team | yes | yes | yes | partial | citation and evidence skills exist, but legal workflow chaining is incomplete |
| Sigma leader team | yes | yes | yes | partial | role alignment improved, but tool auto-run and observability loop remain partial |

---

## Luna Team

- Leader: `luna`
- Selectable agents: yes
- Implemented skills: indirect via selector, shadow hiring, JSONB team tracking integration
- Implemented tools/MCP: market/tool selector path exists
- Workflow status: partial
- Known gaps: strategy-combo reporting and workflow-skill chaining are still limited

## Blo Team

- Leader: `blo`
- Selectable agents: yes
- Implemented skills: dynamic writer selection, competition mode, content-specific registry usage
- Implemented tools/MCP: blog pipeline uses broader LLM/tool stack; MCP workflow is still partial
- Workflow status: partial
- Known gaps: review/qa/ship/retro workflow insertion is not standardized yet

## Darwin Team

- Leader: `darwin`
- Selectable agents: yes
- Implemented skills: `source-ranking`, `counterexample`, `replicator`, `synthesis`, `source-auditor`
- Implemented tools/MCP: `github`, `filesystem`
- Workflow status: partial
- Known gaps: `research-brief` style workflow skill is still missing from live pipeline

## Justin Team

- Leader: `justin`
- Selectable agents: yes
- Implemented skills: `citation-audit`, `evidence-map`, `judge-simulator`, `precedent-comparer`, `damages-analyst`
- Implemented tools/MCP: `filesystem`, `postgresql`
- Workflow status: partial
- Known gaps: legal review chain exists in pieces, but standardized workflow insertion is still pending

## Sigma Team

- Leader: `sigma`
- Selectable agents: yes
- Implemented skills: `data-quality-guard`, `experiment-design`, `causal-check`, `feature-planner`, `observability-planner`
- Implemented tools/MCP: `postgresql`, `filesystem`, `desktop-commander`
- Workflow status: partial
- Known gaps: quality investigation workflow and telemetry feedback loop are not fully connected

---

## 운영 규칙

- 새 Phase가 구현되면 parity도 함께 갱신한다.
- `Implemented=yes`만으로 완료 취급하지 않는다.
- `Pipeline=yes`와 `Ops Verified=yes`가 함께 있어야 운영 준비로 본다.
- `Known Limits`는 숨기지 않고 유지한다.
- 과거 로그나 문서가 아닌 현재 코드/route/DB/스모크 기준으로 갱신한다.
