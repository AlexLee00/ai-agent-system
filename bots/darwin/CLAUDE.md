# CLAUDE.md — 다윈팀 Claude Code 작업 지침

Claude Code(코덱스)가 `bots/darwin/` 작업 시 반드시 준수해야 하는 규칙.

## 1. 역할 경계

- **메티 (claude.ai)**: 설계·점검·프롬프트만. 코드 직접 수정 금지.
- **코덱스 (Claude Code, 이 CLAUDE.md 적용 범위)**: 구현 전담.
- **마스터 (제이)**: 정책 변경 승인 및 예외 개입 담당.

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
| 4 | ✅ 완료 | Commander (Jido.AI.Agent) + 9 Skills + Cycle 7개 |
| 5 | ✅ 완료 | MCP Server + Signal |
| 6 | ✅ 완료 | Shadow 비교 경로 보존 (ShadowRunner + ShadowCompare + TelegramBridge) |
| 7 | ✅ 완료 | 커뮤니티 스캐너 (HN/Reddit/OpenReview/ArxivRSS 센서 4종 + CommunityScanner) |
| 8 | ✅ 완료 | 테스트 335개 (0 failures, 11 excluded) + DB 마이그레이션 5개 |
| CODEX-A | ✅ 완료 | 9팀 통합 채널 — TeamConnector + darwin_team_tech_requests 테이블 + Discover/Apply 통합 |
| CODEX-B | ✅ 완료 | Hypothesis Engine — Sakana AI Scientist 패턴 + darwin_hypotheses 테이블 + Cycle.Hypothesize (8단계) |
| CODEX-C | ✅ 완료 | MEASURE Stage — darwin_effect_measurements + 24h/7d/30d 자동 측정 + Apply 통합 |
| CODEX-H | ✅ 완료 | CodebaseAnalyzer — 9팀 LOC/복잡도/함수수 자동 분석 + darwin_codebase_reports + darwin_module_metrics + 논문 매칭 |

## 4. 코드 작성 표준

### 4-1. Elixir
- `use Jido.AI.Agent` (Commander) — AGENTS.md 구조 참조
- `use Jido.Action` + `schema: Zoi.object(...)` (Skill) — Sigma 패턴 동일
- `@moduledoc` 필수 (상위 문서 참조 포함)
- `mix compile --warnings-as-errors` 경고 0건 필수

### 4-2. TypeScript (bots/darwin/lib/, src/)
- 현재 live Darwin TS는 `tsx` + CommonJS 호환 runtime 기준
- 새 변경은 Darwin 전용 typecheck 먼저 통과시킬 것
- 검증 명령:
  - `bash bots/darwin/scripts/typecheck-darwin-ts.sh`
- packages/core/lib/ 공용 유틸 우선 사용

## 5. LLM 정책 (Darwin.V2.LLM.Selector)

```
evaluator, planner, implementor, verifier → claude-sonnet-4-6
scanner, applier, learner, self_rag.* → claude-haiku-4-5-20251001
principle.critique → claude-opus-4-7
```

## 6. 현재 live 운영 기준

- 자율 레벨: `L5`
- 정상 경로: 승인 버튼 없이 자동 구현/자동 적용
- 알림: 공용 `postAlarm` 경로 사용
- 예외 경로만 수동 버튼 허용
- cadence:
  - Darwin 메인 실행: 주 1회
  - 운영 리포트: 주 1회
  - 주간 리뷰: 주 1회

## 7. Kill Switch 환경변수

```
DARWIN_V2_ENABLED=true                        → V2 전체 기동
DARWIN_CYCLE_ENABLED=true                     → 8단계 사이클 기동
DARWIN_SHADOW_MODE=false                      → live shadow 비활성
DARWIN_KILL_SWITCH=false                      → live kill switch 해제
DARWIN_TIER2_AUTO_APPLY=true                  → L5 자동 적용
DARWIN_L5_ENABLED=true                        → L5 완전자율 허용
DARWIN_MCP_ENABLED=true                       → MCP Server 활성화
DARWIN_ESPL_ENABLED=true                      → ESPL 주간 진화
DARWIN_SELF_RAG_ENABLED=true                  → SelfRAG 4-gate

# Phase A/B/C/H 신규 Kill Switch (기본 false, 단계적 활성화)
DARWIN_TEAM_INTEGRATION_ENABLED=false         → 9팀 기술 요청 통합
DARWIN_HYPOTHESIS_ENGINE_ENABLED=false        → Hypothesis Engine (Sakana AI Scientist)
DARWIN_HYPOTHESIS_LLM_DAILY_BUDGET_USD=2.0    → 가설 생성 일일 LLM 예산
DARWIN_MEASURE_STAGE_ENABLED=false            → MEASURE Stage 24h/7d/30d 효과 측정
DARWIN_CODEBASE_ANALYZER_ENABLED=false        → 9팀 코드 자동 분석 (Phase H)
```

## 8. 커밋 메시지 컨벤션

```
<type>(darwin): <subject>

- 변경 1
- 변경 2
```

**type**: `feat` / `fix` / `refactor` / `docs` / `chore` / `test` / `pre`(롤백 포인트)

## 9. 막히면

1. **즉시 중단**
2. 해당 파일에 `# TODO(메티): ...` 주석 추가
3. 마스터에게 질문 메시지

---

**참조**: SOUL.md 7원칙, AGENTS.md 에이전트 구조, PRINCIPLES.md 연구 원칙
