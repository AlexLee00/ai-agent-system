# LLM Non-Hub Path Audit

## 목적

Hub는 LLM gateway의 단일 제어면이다. 팀별 코드가 Hub를 우회해 provider SDK, provider REST API, `packages/core/lib/llm-fallback`을 직접 호출하면 비용 로그, BillingGuard, OAuth fallback, 장애 격리가 누락된다. 이 문서는 현재 소스코드에서 Hub 표준 경로 외에 남아 있는 불명확한 LLM 호출 경로를 정리한다.

점검 명령:

```bash
npm --prefix bots/hub run -s llm:non-hub-path-audit -- --json
```

현재 감사 결과:

- 스캔 범위: git tracked/untracked source 3,124개 파일
- 상태: `clear`
- `P1`: 0개
- `P2`: 0개
- `P3`: 10개
- `ALLOW`: 23개

## 표준 경로

운영 코드의 기본 경로는 다음 중 하나여야 한다.

- Node/TS 팀 코드: `packages/core/lib/hub-client.callHubLlm`
- Vision 팀 코드: `packages/core/lib/hub-client.callHubVision`
- Embedding/RAG 팀 코드: `packages/core/lib/hub-client.callHubEmbedding` 또는 `POST /hub/llm/embeddings`
- Investment wrapper: `bots/investment/shared/hub-llm-client.callLLMWithHub`
- 외부 프로젝트/비 TS 런타임: `POST /hub/llm/call`, `POST /hub/llm/jobs`, `POST /hub/llm/vision`, `POST /hub/llm/embeddings`
- Hub 내부 구현: `bots/hub/lib/routes/llm.ts` -> `bots/hub/lib/llm/unified-caller.ts`

허용된 provider adapter는 Hub/core 내부로 제한한다.

- `packages/core/lib/llm-fallback.ts`
- `packages/core/lib/llm-keys.ts`
- `bots/hub/lib/llm/unified-caller.ts`
- `bots/hub/lib/routes/llm.ts`

## P1: Hub 우회 가능 운영 경로

현재 P1 운영 우회 경로는 없다. 2026-05-13 기준 아래 항목은 Hub 경로로 이전했다.

| 파일 | 이전 전 상태 | 조치 결과 |
| --- | --- | --- |
| `bots/blog/lib/humanize-agent.ts` | `packages/core/lib/llm-fallback.callLlm` 직접 사용 | `callHubLlm` + `callerTeam=blog` + `selectorKey=blog._default`로 이전 |
| `bots/blog/lib/naver-home-feed-optimizer.ts` | `callLlm` 직접 사용 | `callHubLlm` + `selectorKey=blog.social.caption` + `taskType=home_feed_hashtags`로 이전 |
| `bots/blog/python/reddit_trend_analyzer.py` | `anthropic.Anthropic()` 직접 호출 | Python 표준 라이브러리 HTTP로 `/hub/llm/call` 호출 |
| `bots/investment/luna-commander.cjs` | `spawnSync('claude', ['-p', ... '--dangerously-skip-permissions'])` 직접 실행 | `callHubLlm` + `selectorKey=investment.agent_policy`로 이전 |
| `bots/orchestrator/n8n/setup-ska-workflows.ts` | n8n 워크플로우에 Gemini REST `generateContent?key=` 삽입 | n8n HTTP node가 `HUB_BASE_URL`/`HUB_AUTH_TOKEN` env 기반 `/hub/llm/call`을 호출 |
| `packages/core/lib/gemma-pilot.ts` | core `callWithFallback` 직접 호출 | runtime selector profile을 유지하되 provider 호출은 `callHubLlm`으로 이전 |
| `packages/core/lib/shadow-mode.ts` | Groq SDK 직접 호출 | Hub shadow call로 이전하고 local fallback은 shadow 안전망으로만 유지 |

## P2: 명시 게이트가 있는 우회 가능 경로

현재 P2 운영 우회 가능 경로는 없다. 2026-05-13 기준 남아 있던 3개 항목은 Hub 기능으로 흡수했다.

| 파일 | 이전 전 상태 | 조치 결과 |
| --- | --- | --- |
| `bots/investment/shared/llm-client.ts` | `INVESTMENT_LLM_DIRECT_FALLBACK`로 Hub 실패 시 직접 provider fallback 가능 | provider 직접 fallback 제거. Hub disabled/failed 시 fail-closed |
| `bots/investment/scripts/chart-vision.ts` | public OpenAI Vision 직접 호출 가능 | Hub `/hub/llm/vision` + `callHubVision`으로 이전 |
| `bots/ska/lib/rag_client.py` | public OpenAI embedding 직접 호출 가능 | Hub `/hub/llm/embeddings`로 이전 |

이전 완료:

- `bots/ska/src/forecast.py`: 월간 예측 진단 OpenAI 직접 호출을 `/hub/llm/call`로 이전했다.
- `docs/hub/EXTERNAL_LLM_INTEGRATION_GUIDE.md`: 외부 프로젝트용 Vision/Embedding endpoint 계약을 추가했다.

## P3: 테스트/진단/카오스 경로

테스트, 빌드, 드릴, 카오스 스크립트에는 직접 호출 흔적이 남아 있다. 운영 자동화에서 실행될 수 있는 항목은 confirm/cost cap을 유지한다.

- `bots/blog/__tests__/*`
- `bots/claude/scripts/claude-daily-report.ts`
- `bots/investment/scripts/luna-openai-force-audit-smoke.ts`
- `scripts/build-ts-phase1.mjs`
- `scripts/chaos/llm-failover.ts`
- `scripts/test-korean-quality.ts`
- `tmp/debug-blog-llm-call.ts`

## 권장 해소 순서

1. `llm:non-hub-path-audit -- --strict`는 `check:llm-stage-c`에 편입되어 P1/P2 재발을 차단한다.
2. 남은 `P3`는 테스트/진단/카오스 경로다. live 비용이 발생할 수 있는 항목은 confirm/cost cap을 유지한다.
3. `ALLOW`는 Hub/core provider adapter와 Hub 내부 runtime이다. 팀별 운영 코드는 이 경로를 직접 호출하지 않는다.

## 운영 기준

- `P1 > 0`: Hub 완전 표준화 미완료
- `P1 = 0`, `P2 > 0`: 운영 가능하지만 emergency/direct 게이트 관리 필요
- `P1 = 0`, `P2 = 0`: Hub LLM 제어면 단일화 완료
