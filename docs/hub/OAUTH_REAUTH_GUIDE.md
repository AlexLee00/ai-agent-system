# Claude Code OAuth 재인증 가이드

## 개요

Claude Code OAuth 토큰은 주기적으로 만료됩니다. 토큰 만료 시 LLM 호출이 Groq 폴백으로 자동 전환되지만,
가능한 한 빨리 재인증하여 Claude 모델 품질을 복구해야 합니다.

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
```bash
claude auth login --claudeai --email leejearyong@gmail.com
```

브라우저가 열리며 Anthropic 계정으로 로그인하면 됩니다.

### 3단계: 인증 상태 확인
```bash
claude auth status
```

정상 출력 예시:
```
Logged in as: leejearyong@gmail.com
Token expires: 2026-05-19T03:00:00Z
```

---

## 자동 갱신과 수동 재인증의 경계

Claude Code OAuth는 access token + refresh token 구조입니다.
- access token은 짧은 TTL을 가지며, Hub 모니터가 refresh token으로 자동 갱신합니다.
- refresh 성공 시 Hub token-store와 Claude Code Keychain을 함께 동기화합니다.
- refresh token이 거부되거나 계정 세션/권한이 바뀐 경우에만 브라우저 기반 수동 재인증이 필요합니다.

브라우저 로그인 자체는 사람의 인터랙션이 필요하지만, 정상 상태에서는 반복 로그인 없이 refresh로 유지되는 것이 기대 동작입니다.
모니터 알림은 자동 갱신/동기화가 실패하거나 만료 임박 상태가 해소되지 않을 때만 대응 신호로 사용합니다.

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

# Hub token-store 재import + 만료 모니터 수동 실행
npm --prefix bots/hub run -s oauth:monitor

# refresh + Keychain sync를 강제로 검증
HUB_OAUTH_MONITOR_SEND_ALARM=0 HUB_OAUTH_MONITOR_ALLOW_KEYCHAIN=1 HUB_CLAUDE_OAUTH_WARN_HOURS=9 npm --prefix bots/hub run -s oauth:monitor

# Claude Code CLI 런타임 호출 확인
claude -p 'Reply with exactly: OK' --output-format json --no-session-persistence --model sonnet --max-budget-usd 0.06

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
