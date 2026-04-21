# 다윈팀 (Darwin Team) — Claude Code 작업 지침

> 위치: bots/darwin/
> 버전: V2 (2026-04-18 리모델링)

## 팀 구조

- 팀장: 다윈 (Darwin) — R&D 자율 에이전트
- 구현자: 에디슨 (Edison) — 논문 구현 (R&D의 D)
- 감독: 클로드팀 경유 → 마스터 보고

## 역할 경계

- **메티 (claude.ai)**: 설계·점검·프롬프트만. 코드 직접 수정 절대 금지.
- **코덱스 (Claude Code, 이 파일 적용 범위)**: 구현 전담.
- **마스터 (제이)**: 원칙/정책 변경 승인 및 예외 개입 담당.

## 핵심 디렉토리

- `bots/darwin/elixir/` — 독립 Elixir V2 앱
- `bots/darwin/lib/` — 기존 TS 클라이언트 (arxiv, hf-papers 등) 유지
- `bots/darwin/sandbox/` — 자율 레벨 상태, 키워드 등 로컬 상태
- `bots/darwin/experimental/` — 에디슨 구현 결과물

## V2 아키텍처 (7단계 자율 사이클)

```
DISCOVER → EVALUATE → PLAN → IMPLEMENT → VERIFY → APPLY → LEARN
```

각 단계는 `Darwin.V2.Cycle.*` GenServer로 구현됨.

## 자율 레벨

| 레벨 | 이름 | 조건 | 에디슨 권한 |
|------|------|------|------------|
| L3 | 감독 필요 | 기본값 | 수동 승인 필수 |
| L4 | 반자율 | 5연속 성공 + 7일 | 구현 자동, 적용 전 승인 |
| L5 | 완전자율 | 10연속 + 3건 적용 + 14일 | 정상 경로 자동 적용 |

## Kill Switch 환경변수

```
DARWIN_V2_ENABLED=false      # 기본 OFF — V2 전체 기동
DARWIN_KILL_SWITCH=false     # live L5 기본값
DARWIN_SHADOW_MODE=false     # live는 shadow 종료, 주간 one-shot 운영
DARWIN_CYCLE_ENABLED=true    # 7단계 사이클 기동
DARWIN_L5_ENABLED=true       # L5 완전자율 허용
DARWIN_MCP_ENABLED=true      # MCP Server 활성화
DARWIN_ESPL_ENABLED=true     # ESPL 주간 진화
DARWIN_SELF_RAG_ENABLED=true # SelfRAG 4-gate
DARWIN_LLM_DAILY_BUDGET_USD=10.0  # 일일 LLM 예산
```

## Phase별 상태 (2026-04-18 기준)

| Phase | 상태 | 내용 |
|-------|------|------|
| 0 | ✅ 완료 | 독립 구조 + Kill Switch + mix.exs |
| 1 | ✅ 완료 | LLM Selector + CostTracker + RoutingLog |
| 2 | ✅ 완료 | Memory L1/L2 + AutonomyLevel |
| 3 | ✅ 완료 | Reflexion + SelfRAG + ESPL + Principle Loader |
| 4 | ✅ 완료 | Commander + Skill 9개 + Cycle 7개 |
| 5 | ✅ 완료 | MCP Server + Signal + HTTP Router |
| 6 | ✅ 완료 | ShadowRunner + ShadowCompare + TelegramBridge + RollbackScheduler(24h) (참고용) |
| 7 | ✅ 완료 | 커뮤니티 스캐너 완성 (ArxivRSS/HN/Reddit/OpenReview 센서 4종 + CommunityScanner) |
| 8 | ✅ 완료 | 테스트 335개 (0 failures, 11 excluded) + DB 마이그레이션 5개 |

## DB 테이블

- `reservation.rag_research` — 기존 논문 저장소
- `darwin_v2_shadow_runs` — Shadow 비교 실행 기록
- `darwin_v2_pipeline_audit` — 파이프라인 단계 감사 로그
- `darwin_v2_rollback_log` — 롤백 이력 (Phase 6 신규)

## Live 운영 상태

- live Darwin은 현재 `L5 완전자율` 기준으로 운영한다.
- 정상 성공 경로 알림은 텔레그램 inline button이 없는 공용 `postAlarm` 경로를 사용한다.
- 승인 버튼은 실패/충돌/수동 검토가 필요한 예외 상황에만 남긴다.
- 메인 실행 cadence는 `주 1회`다.
  - `ai.darwin.weekly.autonomous`: 일요일 05:00
  - `ai.darwin.daily-report`: 일요일 06:30
  - `ai.darwin.weekly-review`: 일요일 19:00

## Shadow Mode 운영 절차

1. `DARWIN_SHADOW_MODE=true` 설정
2. V1 평가 이벤트 자동 구독 (`darwin.paper.evaluated`)
3. 7일 이상 + 20건 이상 + avg_match ≥ 95% 달성 시
4. `Darwin.V2.ShadowRunner.shadow_ready?/0` 반환 `true`
5. live 전환 전 승인 절차 완료 후 `DARWIN_V2_ENABLED=true`

## LLM 정책

Claude API 전용 (`Darwin.V2.LLM.Selector` 참조):

```
evaluator / planner / verifier → claude-sonnet-4-6
scanner / applier / learner    → claude-haiku-4-5-20251001
principle.critique             → claude-opus-4-7
임베딩                          → qwen3-embed-0.6b (로컬 MLX, 비용 $0)
```

일일 예산 한도: `$10` (`DARWIN_LLM_DAILY_BUDGET_USD`)
단일 논문 최대 비용: `$5` (초과 시 자동 중단)

## 코드 작성 표준

### Elixir V2

- `use Jido.AI.Agent` (Commander) — 시그마 패턴 준수
- `use Jido.Action` + `schema: Zoi.object(...)` (Skill)
- `@moduledoc` 필수, 한국어 설명
- 로그 prefix: `[다윈V2 {모듈명}]`
- `mix compile --warnings-as-errors` 경고 0건 필수

### 모듈 네이밍

```
Darwin.V2.*         — V2 최상위
Darwin.V2.Cycle.*   — 7단계 사이클 GenServer
Darwin.V2.LLM.*     — LLM 스택
Darwin.V2.Skill.*   — Jido Skills
Darwin.V2.Sensor.*  — 커뮤니티 시그널
Darwin.V2.HTTP.*    — Plug/Bandit HTTP
Darwin.V2.MCP.*     — MCP Server
Darwin.V2.Memory.*  — L1/L2 메모리
```

## 절대 규칙

- OPS 직접 수정 금지
- `verification_passed` 없이 main 적용 금지
- 단일 논문 LLM 비용 $5 초과 금지
- secrets 커밋 금지 (pre-commit hook 자동 차단)
- 로컬 LLM 사용 금지 (MLX 임베딩만 예외)
- V1 (`elixir/team_jay/lib/team_jay/darwin/`) 코드 수정 금지

## 금지 행동

- 민감값 노출 (API 키, Tailscale IP, Hub 토큰)
- V1 코드 수정
- Kill Switch 없는 L5 즉시 활성화
- live L5 정책과 어긋나는 수동 승인 회귀
- `git mv` 없이 파일 이동

## 막히면

1. **즉시 중단**
2. 해당 파일에 `# TODO(메티): ...` 주석 추가
3. 마스터에게 질문 메시지 (코드 커밋 금지)

---

**참조**: `bots/darwin/CLAUDE.md` (최상위), `docs/standards/` (불변 규칙)
`bots/darwin/docs/PLAN.md` (Phase 로드맵), `bots/darwin/SOUL.md` (7원칙)
