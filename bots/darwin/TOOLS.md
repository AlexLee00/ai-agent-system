# TOOLS.md — 다윈팀 도구 생태계

## 1. Elixir V2 코어

### Jido 2.2 (OTP 자율 에이전트)
- Cycle 7단계 + Memory + ESPL 추상화 제공
- `use Jido.Action` + Zoi 스키마

### Bandit + Plug (HTTP)
- MCP Server HTTP 노출 (DARWIN_HTTP_PORT 설정 시)
- 포트: DARWIN_HTTP_PORT 환경변수

## 2. LLM 계층 (Darwin.V2.LLM.Selector)

| 용도 | 모델 | 비용 |
|------|------|------|
| DISCOVER/EVALUATE | qwen2.5-7b (로컬) | $0 |
| PLAN/REFLEXION/LEARN | deepseek-r1-32b (로컬) | $0 |
| PLAN 폴백/빠른 추론 | groq qwen-qwq-32b | ~$0.0001/1K |
| IMPLEMENT/VERIFY | claude-sonnet-4-6 | $0.003/1K in |
| ESPL/원칙평가 | claude-haiku-4-5 | $0.00025/1K in |

## 3. 임베딩

- **Qwen3-Embedding-0.6B** (로컬 MLX, port 11434)
- 1024차원, cosine similarity, $0

## 4. DB

- **PostgreSQL + pgvector** (jay DB, schema: reservation)
- 테이블: darwin_cycle_results, darwin_autonomy_level, darwin_llm_cost_tracking, darwin_llm_routing_log, darwin_v2_shadow_runs, darwin_analyst_prompts

## 5. TypeScript V1 (레거시)

- **callWithFallback** — packages/core/lib/llm-fallback.js
- **arxiv-client.ts** — arXiv API
- **hf-papers-client.ts** — HuggingFace Papers
- **implementor.ts** — 파일 생성 + git (V2 Elixir에서 위임)
- **verifier.ts** — verify-loop 위임

## 6. 외부 소스

| 소스 | URL | 업데이트 |
|------|-----|----------|
| arXiv | export.arxiv.org/api/query | 6시간 |
| HuggingFace | huggingface.co/api/daily_papers | 6시간 |
| HN | hacker-news.firebaseio.com | 1시간 |
| Reddit r/ML | reddit.com/r/MachineLearning | 6시간 |
