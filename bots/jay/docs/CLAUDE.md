# CLAUDE.md — 제이팀(Jay) Claude Code 작업 지침

Claude Code(코덱스)가 `bots/jay/` 작업 시 반드시 준수해야 하는 규칙.

## 1. 역할 경계

- **메티 (claude.ai)**: 설계·점검·프롬프트만. 코드 직접 수정 금지.
- **코덱스 (Claude Code, 이 CLAUDE.md 적용 범위)**: 구현 전담.
- **마스터 (제이)**: 최종 승인.

## 2. 제이팀 작업 원칙

### 2-1. 컴파일 방식

- `bots/jay/elixir/mix.exs`는 **얇은 래퍼** — 실제 컴파일은 `elixir/team_jay`에 위임
- 컴파일/테스트는 `cd elixir/team_jay && mix compile` / `mix test bots/jay/elixir/test`
- `elixir/team_jay/mix.exs`의 `elixirc_paths` + `test_paths`에 jay 경로 이미 추가됨

### 2-2. Namespace 규칙

- `Jay.V2.*` — `bots/jay/elixir/lib/jay/v2/` (제이팀 독립 구현)
- `Jay.Core.*` — `packages/elixir_core/` (공용 레이어, 수정 시 주의)
- `TeamJay.Jay.*` 참조는 모두 `Jay.V2.*`로 변환 완료 (Phase 3)

### 2-3. git mv 엄수

파일 이동/리네임 시 반드시 `git mv` 사용.

### 2-4. 민감값 절대 금지

API 키, Tailscale IP, Hub 토큰 커밋 금지.

## 3. Jay V2 Phase별 상태

| Phase | 상태 | 내용 |
|-------|------|------|
| 1 | ✅ 완료 | 다윈 dead code 제거 + Jido 2.2 |
| 2 | ✅ 완료 | packages/elixir_core/ Jay.Core.* 공용 레이어 |
| 3 | ✅ 완료 | bots/jay/elixir/ 독립 + Jay.V2.Commander + 6 Skills |
| 4 | 🔶 예정 | Commander AgentServer 상시 기동 + launchd 등록 |

## 4. Jay.V2.Commander

```elixir
use Jido.AI.Agent,
  name: "jay_v2_commander",
  model: :smart,
  tools: [6개 Skill],
  system_prompt: "..."
```

**Kill Switch**: `JAY_V2_ENABLED=true` → Supervisor 기동, `JAY_COMMANDER_ENABLED=false` (기본 OFF)

## 5. 6개 Skill

| Skill | 파일 | Wraps |
|-------|------|-------|
| TeamHealthCheck | skill/team_health_check.ex | TeamConnector.collect/* |
| FormationDecision | skill/formation_decision.ex | 신규 LLM + DecisionEngine |
| CrossTeamPipeline | skill/cross_team_pipeline.ex | Topics.broadcast/* |
| AutonomyGovernor | skill/autonomy_governor.ex | AutonomyController |
| DailyBriefingComposer | skill/daily_briefing_composer.ex | TeamConnector → DailyBriefing |
| WeeklyReviewer | skill/weekly_reviewer.ex | WeeklyReport.run/0 |

## 6. Kill Switch 환경변수

```
JAY_V2_ENABLED=true           → Jay.V2.Supervisor 기동
JAY_COMMANDER_ENABLED=false   → Commander AgentServer 기본 OFF
JAY_LLM_DAILY_BUDGET_USD=5.00 → LLM 일일 예산
```

## 7. 커밋 메시지 컨벤션

```
feat(jay): Jay.V2.Commander + 6 Skills 신설
fix(jay): CrossTeamPipeline topic 수정
```

## 8. 막히면

1. **즉시 중단**
2. 해당 파일에 `# TODO(메티): ...` 주석 추가
3. 마스터에게 질문 메시지

---

**참조**: `bots/sigma/CLAUDE.md` (패턴 소스), `packages/elixir_core/` (공용 레이어)
