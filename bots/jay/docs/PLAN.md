# 제이팀 (Jay) 개발 로드맵

> **최종 업데이트**: 2026-04-18 (CODEX_JAY_DARWIN_INDEPENDENCE 완료)

## 현재 상태

| Phase | 상태 | 내용 |
|-------|------|------|
| Phase 3 | ✅ 완료 | 제이팀 독립 + Jay.V2.Commander + 6 Skills + 58 tests |
| Phase 4 | 🔜 대기 | Commander 실제 LLM 호출 + launchd 등록 |
| Phase 5+ | 📋 예정 | 나머지 팀 독립 (blog/ska/claude/investment) |

## Phase 3 완료 내용

- `bots/jay/elixir/` 독립 앱 신설 (얇은 래퍼 — team_jay에 컴파일 위임)
- `Jay.V2.*` 11 모듈 이전 (autonomy_controller / commander / cross_team_router 등)
- `Jay.V2.Commander` — Jido.AI.Agent 기반, 6 tools
- `Jay.V2.Skill.*` 6종 — TeamHealthCheck / FormationDecision / CrossTeamPipeline / AutonomyGovernor / DailyBriefingComposer / WeeklyReviewer
- `Jay.V2.Sigma.*` 3종 — Analyzer / Feedback / Scheduler (sigma 편성 통합)
- `ai.jay.growth.plist` 생성 (launchctl 등록은 마스터 승인 후)

## Phase 4 — Commander 실제 가동 (다음 세션)

1. `JAY_COMMANDER_ENABLED=true` 환경변수 설정
2. `Jay.V2.Supervisor`에 `Jay.V2.Commander` child 추가 (현재 주석)
3. `FormationDecision.handle_signal/2` LLM 실제 호출 (Jido.AI.Agent `chat/2`)
4. `launchctl load ~/Library/LaunchAgents/ai.jay.growth.plist` (마스터 승인 후 OPS에서 실행)

## Kill Switch 환경변수

```
JAY_V2_ENABLED=true           → Jay.V2 전체 기동
JAY_COMMANDER_ENABLED=false   → Commander LLM 호출 비활성 (Phase 3 기본값)
JAY_LLM_DAILY_BUDGET_USD=5.0  → 일일 LLM 비용 상한
```

## 컴파일/테스트 방법

```bash
# 컴파일 (team_jay에 위임)
cd elixir/team_jay && mix compile

# Jay 전용 테스트
cd bots/jay/elixir && mix test
# 또는
cd elixir/team_jay && mix test bots/jay/elixir/test
```
