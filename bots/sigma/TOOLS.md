# TOOLS.md — 시그마 도구 생태계

시그마팀이 사용하는 런타임/프레임워크/라이브러리 전체 목록.

## 1. 코어 프레임워크

### Jido 2.2 (Elixir OTP 자율 에이전트)
- **역할**: 시그마 v2의 근간. Commander/Pod/Skill 추상화 제공.
- **버전**: 2.2.0 (2026-03-29, hex.pm downloads 34,155)
- **특이사항**: `use Jido.AI.Agent` + Zoi 스키마. CloudEvents v1.0 envelope 내장.

### jido_ai 2.1
- **역할**: LLM 통합 레이어. Anthropic/OpenAI/Google 추상화 (req_llm 기반).

### jido_action 2.2, jido_signal 2.1
- **역할**: Action 컨트랙트 + Signal pub/sub.

## 2. LLM 계층

### req_llm 1.9.0
- **역할**: LLM HTTP 추상화. Anthropic/OpenAI/Google/Groq 통합.
- **인기도**: Elixir LLM 생태계 중 가장 많이 쓰임 (89,895 downloads).

### Claude API (Anthropic)
- **모델**: Claude Opus 4.7 / Sonnet 4.6 / Haiku 4.5
- **용도**: Commander(Sonnet), Skill 고품질(Sonnet), Self-Critique(Opus), 경량(Haiku)

### Ollama 로컬 (Apple Silicon Metal)
- **속도 티어**:
  - 8B (실시간, <1초): `qwen2.5-coder:7b-instruct-q4_K_M`
  - 14B (준실시간, 3초): `qwen2.5:14b-instruct-q4_K_M`
  - 32B (배치, 10초): `qwen2.5:32b-instruct-q4_K_M`
  - 70B 4-bit (대용량 배치): `llama3.3:70b-instruct-q4_K_M`

### LLM Selector (Phase 1.5 대기 중)
- **위치**: `bots/sigma/shared/llm-client.ts` + `elixir/lib/sigma/v2/llm/selector.ex`
- **정책**: `packages/core/lib/llm-model-selector.js` 의 `sigma.agent_policy`
- **참고**: `bots/investment/shared/llm-client.ts` (706줄) 패턴

## 3. 데이터 계층

### PostgreSQL 17 + pgvector
- **역할**: 단일 DB (SQL + 벡터). 별도 벡터 DB 없음.
- **접속**: SSH 터널 경유 (DEV → OPS)
- **확장**: `pgvector` (벡터 검색), `pg_trgm` (유사도 검색)

### Postgrex 0.20 (Elixir 드라이버)
- **역할**: 시그마 Elixir v2의 유일한 DB 드라이버. Ecto 미도입.
- **이유**: 시그마 규모에 Ecto schema 오버헤드 > 이익.

### pgvector Elixir 0.3.1
- **역할**: PostgreSQL pgvector 타입 Elixir 바인딩.
- **용도**: `Sigma.V2.Memory.L2` 임베딩 저장/검색.

### Qwen3-Embedding-0.6B (MLX)
- **역할**: 임베딩 생성 (1024차원).
- **비용**: $0 (로컬 MLX).

## 4. 관측성

### OpenTelemetry 1.7 (Elixir)
- **Exporter**: 파일 (`/tmp/sigma_otel.jsonl`) — Phase 0 기본
- **전환**: Phase 4에서 OTLP/HTTP → Grafana Tempo

### Jido.Observe
- **역할**: Jido 내장 관측성. Agent/Action span 자동 래핑.

### Telemetry (Erlang 표준)
- **역할**: 이벤트 발행. `telemetry.attach_many/4`로 핸들러 등록.

## 5. HTTP + MCP

### Plug (Elixir HTTP 라우터)
- **위치**: `bots/sigma/elixir/lib/sigma/v2/http/router.ex`
- **엔드포인트**: `/sigma/v2/run-daily`, `/sigma/v2/health`, `/mcp/sigma`

### agentskills.io MCP Server
- **표준**: Anthropic 공식 Agent Skills (119,340★)
- **설치**: `/plugin marketplace add anthropics/skills` (Claude Code)
- **시그마 포맷**: `skills/<skill-name>/SKILL.md` + `.claude-plugin/plugin.json`

## 6. 테스트

### ExUnit (Elixir)
- **위치**: `bots/sigma/elixir/test/sigma/v2/`
- **범위**: Skill unit test (Phase 1, 30개) + E2E

### Vitest (TS)
- **위치**: `bots/sigma/__tests__/` (Phase B 이후 신설)

## 7. DevOps

### launchd (macOS)
- **파일**: `bots/sigma/launchd/ai.sigma.daily.plist`
- **스케줄**: 매일 21:30 (Mac Studio)

### Git (히스토리 보존)
- **원칙**: `git mv` 엄수. `cp + rm` 금지.

### pre-commit 훅
- **경로**: `scripts/pre-commit`
- **차단**: Hub 토큰, Tailscale IP, API 키

### deploy.sh (5분 cron)
- **역할**: OPS 자동 pull + 재빌드

## 8. Skills (agentskills.io 포맷)

- **표준**: YAML frontmatter + markdown body
- **5개**:
  - `skills/data-quality-guard/SKILL.md`
  - `skills/causal-check/SKILL.md`
  - `skills/experiment-design/SKILL.md`
  - `skills/feature-planner/SKILL.md`
  - `skills/observability-planner/SKILL.md`

## 9. 외부 참조

### 루나팀 (bots/investment/)
- **역할**: 시그마팀 구조 표준 참고 템플릿
- **핵심 파일**: `shared/llm-client.ts`, `shared/llm.ts`, `AGENTS.md`, `SOUL.md`

### packages/core/lib/
- **llm-model-selector.js**: 중앙 LLM 정책 레지스트리 (시그마도 `sigma.agent_policy` 추가 예정)
- **llm-fallback.js**: 폴백 체인 엔진
- **agent-registry.js**: 에이전트 메타 레지스트리

## 10. 금지 도구 (신중 사용)

- ❌ **Ecto ORM** — 시그마 규모에 과도. Postgrex 직접 사용.
- ❌ **vLLM** — Apple Silicon 호환 미흡. Ollama만 사용.
- ❌ **ChromaDB** — pgvector로 통합. 별도 벡터 DB 없음.
- ⚠️ **CloudEvents 패키지** — 별도 설치 불필요. jido_signal에 내장.

---

**다음 단계**: [USER.md](./USER.md) — 마스터(제이) 컨텍스트
