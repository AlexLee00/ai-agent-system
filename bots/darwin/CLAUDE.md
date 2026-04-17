# CLAUDE.md — 다윈팀 Claude Code 작업 지침

Claude Code(코덱스)가 `bots/darwin/` 작업 시 반드시 준수해야 하는 규칙.

## 1. 역할 경계

- **메티 (claude.ai)**: 설계·점검·프롬프트만. 코드 직접 수정 금지.
- **코덱스 (Claude Code, 이 CLAUDE.md 적용 범위)**: 구현 전담.
- **마스터 (제이)**: 최종 승인.

## 2. 다윈팀 작업 원칙

### 2-1. 기존 TS 다윈 수정 주의

- `bots/darwin/lib/**` — 기존 TS 로직 유지 (V2 Elixir 안정화 후 점진적 교체)
- `bots/darwin/src/**` — 원본 유지

### 2-2. Darwin V2 vs TeamJay.Darwin 분리

- `Darwin.V2.*` → `bots/darwin/elixir/lib/darwin/v2/` (신규 독립 구현)
- `TeamJay.Darwin.*` → `elixir/team_jay/lib/team_jay/darwin/` (기존 레거시 브리지)
- V2가 안정화되면 `TeamJay.Darwin.*`은 V2로 위임

### 2-3. `git mv` 엄수

파일 이동/리네임 시 반드시 `git mv` 사용. 히스토리 보존.

### 2-4. 민감값 절대 금지

API 키, Tailscale IP, Hub 토큰은 절대 커밋 금지.

## 3. Darwin V2 Phase별 상태

| Phase | 상태 | 내용 |
|-------|------|------|
| 0 | ✅ 완료 | 독립 구조 + Kill Switch + mix.exs 통합 |
| 1 | ✅ 완료 | LLM Selector + CostTracker + RoutingLog |
| 2 | ✅ 완료 | Memory L1/L2 + AutonomyLevel |
| 3 | ✅ 완료 | Reflexion + SelfRAG + ESPL + Principle Loader |
| 4 | ✅ 완료 | Commander (Jido.AI.Agent) + Skill 3개 + Cycle 7개 |
| 5 | ✅ 완료 | MCP Server + Signal |
| 6 | 🔶 예정 | Shadow Mode (TeamJay.Darwin vs Darwin.V2 병행 비교) |
| 7 | 🔶 예정 | 커뮤니티 스캐너 (HN/Reddit/Twitter 시그널) |

## 4. 코드 작성 표준

### 4-1. Elixir
- `use Jido.AI.Agent` (Commander) — AGENTS.md 구조 참조
- `use Jido.Action` + `schema: Zoi.object(...)` (Skill) — Sigma 패턴 동일
- `@moduledoc` 필수 (상위 문서 참조 포함)
- `mix compile --warnings-as-errors` 경고 0건 필수

### 4-2. TypeScript (bots/darwin/lib/, src/)
- ESM import/export
- packages/core/lib/ 공용 유틸 우선 사용

## 5. LLM 정책 (Darwin.V2.LLM.Selector)

```
evaluator, planner, implementor, verifier → claude-sonnet-4-6
scanner, applier, learner, self_rag.* → claude-haiku-4-5-20251001
principle.critique → claude-opus-4-7
```

## 6. Kill Switch 환경변수

```
DARWIN_V2_ENABLED=true         → V2 전체 기동
DARWIN_CYCLE_ENABLED=true      → 7단계 사이클 기동
DARWIN_SHADOW_ENABLED=true     → Shadow Mode 활성화
DARWIN_L5_ENABLED=true         → L5 완전자율 허용
DARWIN_MCP_ENABLED=true        → MCP Server 활성화
DARWIN_ESPL_ENABLED=true       → ESPL 주간 진화
DARWIN_SELF_RAG_ENABLED=true   → SelfRAG 4-gate
```

## 7. 커밋 메시지 컨벤션

```
<type>(darwin): <subject>

- 변경 1
- 변경 2
```

**type**: `feat` / `fix` / `refactor` / `docs` / `chore` / `test` / `pre`(롤백 포인트)

## 8. 막히면

1. **즉시 중단**
2. 해당 파일에 `# TODO(메티): ...` 주석 추가
3. 마스터에게 질문 메시지

---

**참조**: SOUL.md 7원칙, AGENTS.md 에이전트 구조, PRINCIPLES.md 연구 원칙
