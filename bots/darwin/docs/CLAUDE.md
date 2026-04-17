# CLAUDE.md — 다윈팀 작업 지침

Claude Code(코덱스)가 `bots/darwin/` 작업 시 준수해야 하는 규칙.

## 1. 역할 경계

- **메티 (claude.ai)**: 설계·점검·프롬프트만. 코드 직접 수정 금지.
- **코덱스 (Claude Code, 이 CLAUDE.md 적용 범위)**: 구현 전담.
- **마스터 (제이)**: 최종 승인.

## 2. 다윈팀 작업 원칙

### 2-1. 기존 TS 코드 수정 최소화

- `bots/darwin/lib/**` — **원본 유지** (외부 API 클라이언트만)
- Elixir V2 구현이 TS를 Port 방식으로 호출하는 구조 유지

### 2-2. V1 Elixir 코드 보존

- `elixir/team_jay/lib/team_jay/darwin/` — **원본 유지** (Shadow 비교 baseline)
- V2와 V1 병행 실행, 7일 관찰 후 V2 전환

### 2-3. 불변 원칙 준수 (CODEX_DARWIN_REMODEL 섹션 참조)

1. 시그마 패턴 준수
2. 기존 자율 레벨 시스템 유지 (L3/L4/L5)
3. 기존 7단계 사이클 유지
4. 독립 LLM Selector (`Darwin.V2.LLM.Selector`)
5. **Claude API 전용** (로컬 LLM 제외, MLX 임베딩만 허용)
6. JayBus 기존 토픽 유지
7. 기존 TS 코드 보존
8. Shadow 우선 (7일 관찰 후 승급)
9. Kill Switch 기본 OFF

### 2-4. 보안 규칙

커밋 금지:
- ANTHROPIC_API_KEY
- Hub 토큰
- Tailscale IP
- 모든 API 키

## 3. Darwin V2 Phase별 행동

| Phase | 상태 | 지시 |
|-------|------|------|
| 1 | 🔶 진행 | Foundation (Application/Supervisor/LLM Stack) |
| 2 | ⏳ 예정 | Commander (Jido.AI.Agent) + Memory L1/L2 |
| 3 | ⏳ 예정 | 7단계 사이클 Elixir 이전 |
| 4 | ⏳ 예정 | Reflexion + SelfRAG + ESPL |
| 5 | ⏳ 예정 | Shadow Mode + MCP Server + HTTP |
| 6 | ⏳ 예정 | Sensors (HN/Reddit/OpenReview) |
| 7 | ⏳ 예정 | Jido Skills (TreeSearch/VLM/ResourceAnalyst) |
| 8 | ⏳ 예정 | 테스트 200+ |

## 4. 코드 작성 표준

### 4-1. Elixir (V2 신규)
- `use Jido.AI.Agent` (Commander) — 시그마 패턴 복사
- `use Jido.Action` (Skill) — 시그마 Skill 패턴
- `@moduledoc` 필수
- `mix compile --warnings-as-errors` 경고 0건

### 4-2. 모듈 네이밍
- `Darwin.V2.*` — 모든 V2 신규 모듈
- `Darwin.V2.Cycle.*` — 7단계 사이클
- `Darwin.V2.LLM.*` — LLM 스택
- `Darwin.V2.Skill.*` — Jido Skills
- `Darwin.V2.Sensor.*` — 커뮤니티 시그널

## 5. LLM 정책

Claude API 전용 (`Darwin.V2.LLM.Selector` 참조):
- 오케스트레이션/평가/계획: `claude-sonnet-4-6`
- 배치/분류: `claude-haiku-4-5-20251001`
- 원칙 비판/복잡 추론: `claude-opus-4-7`

일일 예산: `$10` (`DARWIN_LLM_DAILY_BUDGET_USD`)

## 6. 참조 문서

- `docs/standards/01-autonomy-levels.md` — L3/L4/L5 정의
- `docs/standards/02-signal-topics.md` — JayBus 토픽
- `docs/standards/03-kill-switches.md` — 환경변수 제어
- `docs/standards/04-llm-policy.md` — LLM 라우팅 정책
- `docs/standards/05-memory-schema.md` — 메모리 스키마
- `docs/standards/09-shadow-criteria.md` — Shadow Mode 기준

## 7. 금지 행동

- ❌ 민감값 노출
- ❌ V1 코드 수정
- ❌ 로컬 LLM 사용 (MLX 임베딩 제외)
- ❌ Kill Switch 없는 L5 즉시 활성화
- ❌ 마스터 승인 없는 Tier 2 자동 적용

---

**참조**: 팀 CLAUDE.md (최상위), CODEX_DARWIN_REMODEL.md (로컬)
