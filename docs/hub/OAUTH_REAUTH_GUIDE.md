# Hub OAuth 재인증 가이드

## 개요

Hub는 Claude Code OAuth와 OpenAI Codex OAuth를 함께 관리합니다. 토큰 만료 시 LLM 호출이 폴백으로 전환될 수 있으므로,
가능한 한 자동 refresh로 유지하고 자동 복구가 실패할 때만 수동 재인증합니다.

---

## 알림 시나리오

### 만료 전 경고
`ai.hub.llm-oauth-monitor` (2시간마다 실행, `RunAtLoad=true`)가 만료 4시간 전 감지 시:

```
[oauth] 토큰 갱신 필요: 3.5h 후 만료
```

이때 모니터는 먼저 Hub token-store의 Claude Code `refresh_token`으로 access token 갱신을 시도합니다.
refresh가 성공하면 새 access/refresh token을 Hub token-store와 Claude Code Keychain에 함께 반영합니다.
이 동기화가 필요합니다. Claude Code CLI adapter는 런타임 호출 시 Keychain을 읽기 때문에 Hub만 refresh하고 Keychain을 갱신하지 않으면 CLI가 낡은 토큰으로 401을 낼 수 있습니다.
refresh 실패 또는 갱신 후에도 만료 임박 상태이면 Claude Code Keychain/CLI credential 재import를 한 번 더 시도합니다.
자동 refresh, Keychain sync, 재import 후에도 만료 임박 상태이면 `/tmp/hub-llm-oauth-monitor.log`에 기록하고 Hub 알림을 발송합니다.
1시간 이내로 줄어들면 critical 알림으로 승격합니다.

OpenAI Codex OAuth도 같은 모니터가 관리합니다. 기본값은 만료 24시간 전 경고, 4시간 전 critical입니다.
OpenAI refresh가 성공하면 Hub token-store를 갱신하고 `HUB_OAUTH_MONITOR_SYNC_LOCAL_CODEX=true`일 때 `~/.codex/auth.json`도 함께 동기화합니다.
이 동기화가 필요합니다. Codex CLI와 Hub가 같은 refresh token 체인을 공유하므로 Hub만 refresh하면 로컬 Codex credential이 낡아질 수 있습니다.

### 만료 후 긴급 알림
토큰이 만료되어 LLM 호출이 실패하기 시작하면:

```
[oauth] 토큰 만료: not_authenticated
```

이 경우 모든 Claude Code OAuth 호출이 차단되고 Groq 폴백으로만 동작합니다.

---

## 수동 재인증 절차

### 1단계: OPS 머신에서 터미널 열기
OPS(맥 스튜디오)에 직접 접근하거나 SSH로 연결합니다.

### 2단계: 재인증 명령 실행

Claude Code:
```bash
claude auth login --claudeai --email leejearyong@gmail.com
```

브라우저가 열리며 Anthropic 계정으로 로그인하면 됩니다.

OpenAI Codex:
```bash
codex login
```

브라우저가 열리며 ChatGPT/OpenAI 계정으로 로그인하면 됩니다.

### 3단계: 인증 상태 확인
```bash
claude auth status
codex login status
```

정상 출력 예시:
```
Logged in as: leejearyong@gmail.com
Token expires: 2026-05-19T03:00:00Z
```

---

## 자동 갱신과 수동 재인증의 경계

Claude Code OAuth와 OpenAI Codex OAuth는 access token + refresh token 구조입니다.
- access token은 짧은 TTL을 가지며, Hub 모니터가 refresh token으로 자동 갱신합니다.
- Claude refresh 성공 시 Hub token-store와 Claude Code Keychain을 함께 동기화합니다.
- OpenAI refresh 성공 시 Hub token-store와 Codex auth file을 함께 동기화합니다.
- refresh token이 거부되거나 계정 세션/권한이 바뀐 경우에만 브라우저 기반 수동 재인증이 필요합니다.

OpenAI/Claude public API와 OpenAI Codex OAuth/Claude Code OAuth는 별도 경로입니다.
Hub 운영 경로는 기본적으로 OpenAI Codex OAuth는 ChatGPT/Codex backend, Claude는 Claude Code CLI OAuth를 사용합니다. OpenAI public API 토큰은 Codex OAuth 토큰과 분리하며, `OPENAI_OAUTH_PUBLIC_API_TOKEN` 또는 `OPENAI_PUBLIC_API_TOKEN`이 없으면 public API canary/call을 사용하지 않고 skipped로 기록합니다. Claude/Anthropic public API도 `HUB_ENABLE_CLAUDE_PUBLIC_API=1` 또는 `HUB_ENABLE_ANTHROPIC_PUBLIC_API=1`이 없으면 `ANTHROPIC_API_KEY`/secret-store 키를 사용하지 않습니다.

public API 토큰이 있을 때만 `/v1/responses` canary를 실행하고, 이 경로에서 `api.responses.write` scope 부족이 나오면 Hub는 기본적으로 backend canary로 운영 가능성을 재확인합니다. public API 권한을 배포 게이트로 강제하려면 `OPENAI_CODEX_OAUTH_REQUIRE_PUBLIC_API=1`을 설정하고 계정/조직/프로젝트 권한을 조정하거나 해당 scope가 있는 별도 public API token을 설정해야 합니다.

### OpenClaw에서 권한 부족이 보이지 않았던 이유

OpenClaw 소스 분석 기준으로, OpenClaw는 Codex OAuth를 일반 OpenAI public API 토큰처럼 쓰지 않습니다. `openai-codex` provider와 `openai-codex-responses` API를 별도 모델 경로로 취급하고, 기본 설정도 `https://chatgpt.com/backend-api` 계열 backend를 사용합니다. 사용량/쿨다운 확인 역시 `https://chatgpt.com/backend-api/wham/usage`와 `ChatGPT-Account-Id` 헤더를 사용합니다.

따라서 OpenClaw 사용 중 권한 부족이 보이지 않았던 것은 이상 징후가 아니라, 정상 운영 경로가 public `/v1/responses`가 아니었기 때문입니다. Hub도 같은 계약을 따르며, public API 토큰이 비어 있으면 public `/v1/responses`는 사용하지 않습니다. 반대로 public OpenAI API를 반드시 직접 사용해야 하는 배포에서는 `OPENAI_CODEX_OAUTH_REQUIRE_PUBLIC_API=1`로 엄격 모드를 켜고, public API scope가 있는 계정/API key 경로를 별도 확보해야 합니다.

브라우저 로그인 자체는 사람의 인터랙션이 필요하지만, 정상 상태에서는 반복 로그인 없이 refresh로 유지되는 것이 기대 동작입니다.
모니터 알림은 자동 갱신/동기화가 실패하거나 만료 임박 상태가 해소되지 않을 때만 대응 신호로 사용합니다.

---

## Gemini OAuth 연결

Google 공식 Gemini OAuth quickstart 기준으로, Hub는 `gemini-oauth` provider를 별도 experimental provider로 둡니다.

필수 설정:
- `HUB_ENABLE_GEMINI_OAUTH=true`
- `HUB_GEMINI_OAUTH_CLIENT_ID`
- `HUB_GEMINI_OAUTH_CLIENT_SECRET`
- `GEMINI_OAUTH_PROJECT_ID` 또는 `GOOGLE_CLOUD_QUOTA_PROJECT` 또는 `GOOGLE_CLOUD_PROJECT`

기본 endpoint/scope:
- authorize: `https://accounts.google.com/o/oauth2/v2/auth`
- token: `https://oauth2.googleapis.com/token`
- scope: `https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/generative-language.retriever`

대안: Google ADC import
Google Cloud CLI가 있는 환경에서는 공식 quickstart처럼 `gcloud auth application-default login --client-id-file=client_secret.json --scopes=...`로 ADC를 만든 뒤 Hub token store로 가져올 수 있습니다. 이 경로는 `HUB_GEMINI_OAUTH_CLIENT_SECRET`를 launchd에 넣지 않고도 `refresh_token -> access_token` 갱신 결과만 Hub에 저장합니다.

```bash
npx tsx bots/hub/scripts/gemini-oauth-adc-import.ts \
  --adc-file ~/.config/gcloud/application_default_credentials.json \
  --project-id "$GEMINI_OAUTH_PROJECT_ID"
```

상태/시작/콜백/리프레시:
```bash
curl -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  "http://127.0.0.1:7788/hub/oauth/gemini/status?canary=1"

curl -X POST -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  "http://127.0.0.1:7788/hub/oauth/gemini/start"

curl -X POST -H "Authorization: Bearer $HUB_AUTH_TOKEN" \
  "http://127.0.0.1:7788/hub/oauth/gemini/refresh"
```

canary는 `GET https://generativelanguage.googleapis.com/v1/models`에 Bearer token과 `x-goog-user-project`를 붙여 검증합니다. 실제 LLM 호출은 `gemini-oauth` provider로 `generateContent` REST endpoint를 사용합니다.

---

## Groq 단독 운영 폴백 절차

OAuth 만료 시 시스템은 자동으로 Groq 폴백으로 전환됩니다.

### 폴백 모델 매핑
| Claude 모델 | Groq 폴백 모델 |
|-------------|---------------|
| anthropic_haiku | llama-3.1-8b-instant |
| anthropic_sonnet | llama-3.3-70b-versatile |
| anthropic_opus | qwen-qwq-32b |

### 폴백 상태 확인
```bash
# Hub 헬스 확인
curl -H "Authorization: Bearer $HUB_AUTH_TOKEN" http://127.0.0.1:7788/hub/llm/health

# Groq 계정 가용성 확인
curl -H "Authorization: Bearer $HUB_AUTH_TOKEN" http://127.0.0.1:7788/hub/llm/health | jq '.components.groq'
```

### 주간 Groq 단독 테스트
`ai.hub.llm-groq-fallback-test` (매주 일요일 05:00 KST)가 자동으로 3개 모델을 테스트하고
결과를 Telegram 채널에 보고합니다.

---

## 확인 명령 요약

```bash
# OAuth 토큰 상태
claude auth status
codex login status

# Hub token-store 재import + 만료 모니터 수동 실행
npm --prefix bots/hub run -s oauth:monitor

# refresh + Keychain sync를 강제로 검증
HUB_OAUTH_MONITOR_SEND_ALARM=0 HUB_OAUTH_MONITOR_ALLOW_KEYCHAIN=1 HUB_CLAUDE_OAUTH_WARN_HOURS=9 npm --prefix bots/hub run -s oauth:monitor

# Claude Code CLI 런타임 호출 확인
claude -p 'Reply with exactly: OK' --output-format json --no-session-persistence --model sonnet --max-budget-usd 0.06

# OpenAI OAuth 직접 호출 확인
npx tsx -e "import { callWithFallback } from './packages/core/lib/llm-fallback.ts'; (async () => { const r = await callWithFallback({ chain: [{ provider: 'openai-oauth', model: 'gpt-5.4-mini', maxTokens: 8, temperature: 0.1 }], systemPrompt: 'Smoke test.', userPrompt: 'Reply exactly: OK', timeoutMs: 30000 }); console.log(JSON.stringify({ provider: r.provider, model: r.model, text: r.text })); })();"

# OpenAI primary 팀 live drill
HUB_TEAM_LLM_DRILL_LIVE=1 HUB_TEAM_LLM_DRILL_SCENARIOS='luna:default:openai-oauth:0.02,ska:default:openai-oauth:0.02,video:default:openai-oauth:0.02,orchestrator:default:openai-oauth:0.02' HUB_TEAM_LLM_DRILL_OUTPUT=none npm --prefix bots/hub run -s team:llm-drill

# Hub LLM 헬스 전체
curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" http://127.0.0.1:7788/hub/llm/health | jq .

# 예산 사용 현황
curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" http://127.0.0.1:7788/hub/budget/usage | jq .

# OAuth 모니터 로그
tail -50 /tmp/hub-llm-oauth-monitor.log

# Groq 폴백 테스트 로그
tail -50 /tmp/hub-llm-groq-fallback-test.log

# LLM 호출 통계 (24h)
curl -s -H "Authorization: Bearer $HUB_AUTH_TOKEN" "http://127.0.0.1:7788/hub/llm/stats?hours=24" | jq '.totals'
```

---

## 참조

- OAuth 모니터 launchd: `bots/hub/launchd/ai.hub.llm-oauth-monitor.plist`
- Groq 폴백 테스트: `bots/hub/launchd/ai.hub.llm-groq-fallback-test.plist`
- 모델 레지스트리: `packages/core/lib/llm-models.json`
- LLM 대시보드: `http://127.0.0.1:7788/hub/llm/dashboard`
