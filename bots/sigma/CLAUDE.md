# CLAUDE.md — Claude Code 시그마팀 작업 지침

Claude Code(코덱스)가 `bots/sigma/` 작업 시 반드시 준수해야 하는 규칙.

## 1. 역할 경계

- **메티 (claude.ai)**: 설계·점검·프롬프트만. 코드 직접 수정 금지.
- **코덱스 (Claude Code, 이 CLAUDE.md 적용 범위)**: 구현 전담.
- **마스터 (제이)**: 최종 승인.

## 2. 시그마 작업 원칙

### 2-1. 기존 TS 시그마 수정 금지

- `bots/sigma/ts/**` — **원본 유지** (Phase 5에서 thin adapter로 교체)
- `bots/sigma/legacy-skills/**` — **원본 유지** (죽은 코드지만 비교 baseline)

### 2-2. 공용 인프라 직접 수정은 신중하게

- 시그마의 **공식 entrypoint**는 `bots/sigma/**` 입니다.
- 다만 현재 런타임/DB/허브는 `elixir/team_jay` 인프라를 공유합니다.
- 따라서 `elixir/team_jay` 쪽 수정은 시그마 독립 경로를 살리기 위한 **공용 인프라 보수**일 때만 허용합니다.
- 옛 시그마 포트(`elixir/team_jay/lib/team_jay/jay/sigma/`)는 shadow 비교 목적 외에는 확장하지 않습니다.

### 2-3. `git mv` 엄수

파일 이동/리네임 시 반드시 `git mv` 사용. 히스토리 보존.

### 2-4. 민감값 절대 금지

다음 패턴을 커밋하지 않음:
- Hub 토큰 (`69686445...`)
- Tailscale IP (`100.xx.xx.xx`)
- API 키 (`sk-ant-...`, `ghp_...`, `gho_...`)

pre-commit 훅이 차단. 우회 금지.

## 3. 시그마 Phase별 행동

| Phase | 상태 | 지시 |
|-------|------|------|
| 0 | ✅ 완료 | 추가 작업 없음 |
| 1 | ✅ 완료 | Jido.AI.Agent + 17 모듈 + shadow mode |
| 2 | ✅ 완료 | signal/directive/archivist |
| 3 | ✅ 완료 | config snapshot + rollback + reflexion |
| 4 | ✅ 완료 | ESPL + registry + mailbox |
| 5 | ✅ 완료 | TS 폐기 + MCP Server + 다윈 분리 |
| 1.5 | 🔶 대기 | **LLM Selector** 모듈 (본 문서 §5) |

## 4. 코드 작성 표준

### 4-1. Elixir
- `use Jido.AI.Agent` (Commander/Pod) — 설계서 D-03
- `use Jido.Action` + `schema: Zoi.object(%{...})` (Skill) — 설계서 D-02
- `@moduledoc` 필수 (상위 문서 참조 포함)
- `mix compile --warnings-as-errors` 경고 0건 필수

### 4-2. TypeScript (shared/ + ts/)
- `@ts-nocheck` 사용 가능 (루나 패턴)
- ESM import/export (`import { x } from './y.ts'`)
- 루나 `bots/investment/shared/llm-client.ts` 패턴 참고

## 5. LLM Selector 작업 시 (Phase 1.5)

### 참조 파일
1. `bots/investment/shared/llm-client.ts` (706줄) — 패턴 원본
2. `bots/investment/shared/llm.ts` (21줄) — 하위호환 래퍼
3. `packages/core/lib/llm-model-selector.js` — 중앙 레지스트리
4. `packages/core/lib/llm-fallback.js` — 폴백 체인
5. `packages/core/lib/agent-registry.js` — 에이전트 정책

### 만들어야 할 파일
- `bots/sigma/shared/llm-client.ts` — 시그마 LLM 게이트웨이
- `bots/sigma/shared/llm.ts` — callHaiku/callSonnet/callOpus 어댑터
- `bots/sigma/shared/cost-tracker.ts` — 비용 추적
- `bots/sigma/shared/secrets.ts` — 시크릿 로더
- `bots/sigma/elixir/lib/sigma/v2/llm/selector.ex` — Elixir Selector
- `bots/sigma/elixir/lib/sigma/v2/llm/cost_tracker.ex` — Elixir 비용 추적

### 수정해야 할 파일
- `packages/core/lib/llm-model-selector.js` — `sigma.agent_policy` 키 추가

### 시그마 LLM 정책 (기본값)

```yaml
sigma.agent_policy:
  commander:       { route: anthropic_sonnet, fallback: [haiku, ollama_32b] }
  pod.risk:        { route: anthropic_sonnet, fallback: [haiku, ollama_32b] }
  pod.growth:      { route: anthropic_haiku,  fallback: [ollama_14b] }
  pod.trend:       { route: anthropic_haiku,  fallback: [ollama_14b] }
  skill.data_quality:      { route: ollama_8b,      fallback: [haiku] }
  skill.causal:            { route: anthropic_sonnet, fallback: [haiku] }
  skill.experiment_design: { route: anthropic_sonnet, fallback: [haiku] }
  skill.feature_planner:   { route: anthropic_haiku,  fallback: [ollama_14b] }
  skill.observability:     { route: anthropic_haiku,  fallback: [ollama_14b] }
  principle.self_critique: { route: anthropic_opus,  fallback: [sonnet] }
  reflexion:               { route: anthropic_sonnet, fallback: [haiku] }
  espl:                    { route: anthropic_sonnet, fallback: [haiku] }
```

## 6. 문서 참조 우선순위

작업 전 반드시 읽을 것:
1. `bots/sigma/SOUL.md` (7원칙)
2. `bots/sigma/AGENTS.md` (에이전트 정의)
3. `bots/sigma/docs/PLAN.md` 해당 Phase 섹션
4. `bots/sigma/docs/codex/PHASE_*.md` (로컬, 실제 실행 지시)

## 7. 커밋 메시지 컨벤션

```
<type>(sigma): <subject>

- 변경 1
- 변경 2

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

**type**: `feat` / `fix` / `refactor` / `docs` / `chore` / `test` / `pre`(롤백 포인트)

## 8. 금지 행동

- ❌ 민감값 노출
- ❌ v1 수정
- ❌ `git mv` 없이 파일 이동
- ❌ 마스터 승인 없는 launchd 배포
- ❌ `pre-commit` 훅 우회
- ❌ 설계서/Phase 프롬프트와 다른 파일명/경로 사용

## 9. 막히면

작업 중 설계 모호하거나 결정 필요하면:
1. **즉시 중단**
2. 해당 파일에 `# TODO(메티): ...` 주석 추가
3. 마스터에게 질문 메시지 (코드 커밋 금지)

---

**참조**: SOUL.md 원칙, AGENTS.md 구조, USER.md 마스터 컨텍스트
