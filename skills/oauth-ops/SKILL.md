---
name: oauth-ops
description: Use when diagnosing, operating, or standardizing Hub LLM OAuth refresh/reimport incidents for Claude Code OAuth, OpenAI Codex OAuth, Gemini OAuth, Gemini CLI OAuth, Gemini Code Assist service, and Groq pool readiness.
---

# OAuth Ops

이 스킬은 Hub LLM OAuth 운영 절차를 표준화한다. Refresh 자동화 자체는 `ai.hub.llm-oauth-monitor` launchd와 Hub 런타임이 담당한다. 스킬은 장애 대응, 재인증 판단, 리포트 해석, 운영자 액션 정리에만 사용한다.

## 기본 원칙

- 원문 토큰, refresh token, authorization header, client secret, API key를 출력하지 않는다.
- `ai.hub.llm-oauth-monitor`는 유지한다. 이 job은 15분 polling과 refresh/reimport를 담당한다.
- `llm-oauth4-master-review`는 daily 또는 on-demand 리포트로 취급한다. 실시간 refresh 책임을 주지 않는다.
- 장애 판단은 Hub selector/provider 상태, token-store expiry, live probe, local reimport 결과를 분리해서 본다.
- Gemini CLI OAuth는 짧은 수명 토큰 특성이 있으므로 live refresh probe와 reimport 결과를 함께 확인한다.

## 빠른 점검

```bash
npm --prefix bots/hub run -s oauth:monitor
npm --prefix bots/hub run -s oauth:runtime-refresh-gate
npm --prefix bots/hub run -s oauth:ops-readiness
```

Hub control tool로 조회할 수 있으면 먼저 read-only tool을 쓴다.

- `oauth.ops.status`: provider별 expiry/healthy 상태 조회
- `oauth.ops.events`: `agent.event_lake`의 `hub_oauth_monitor` 표준 이벤트 조회
- `oauth.ops.lock_janitor_plan`: OAuth refresh lock dry-run janitor 계획 조회

## 장애 대응 기준

- `healthy=false`: provider 인증 자체가 깨진 상태다. refresh/reimport 결과와 error를 확인하고 브라우저 재인증 또는 CLI login을 진행한다.
- `needs_refresh=true`: 만료 임박이다. monitor가 refresh/reimport를 시도했는지 먼저 본다.
- `refresh_ok=true`: Hub token-store refresh는 성공했다. local sync 실패 여부만 별도로 본다.
- `reimport_ok=true` 또는 `post_probe_reimport_ok=true`: 로컬 credential을 token-store에 재반영했다.
- `live_probe_ok=false`: token-store가 있어도 실제 호출 경로가 실패한다. provider cooldown, 권한, 네트워크, CLI 상태를 분리해서 본다.
- `lock_timeout`: refresh lock이 오래 남은 상태일 수 있다. `oauth.ops.lock_janitor_plan` 후 필요 시 별도 승인으로 janitor apply를 진행한다.

## Provider별 재인증 메모

- Claude Code OAuth: Claude CLI login/keychain 상태와 Hub token-store를 분리해서 본다. Sonnet quota 이슈와 OAuth 만료 이슈를 혼동하지 않는다.
- OpenAI Codex OAuth: Codex local auth와 Hub token-store sync를 확인한다. OpenAI public API key는 옵션이며 기본 경로가 아니다.
- Gemini CLI OAuth: CLI가 live refresh를 수행할 수 있으면 만료 임박 local token이어도 즉시 장애로 보지 않는다.
- Gemini OAuth: quota project와 Code Assist service 활성 상태를 함께 본다.
- Groq: 여러 키 pool 상태를 확인하되 OAuth refresh 범위와 분리한다.

## 금지

- 스킬 절차 안에서 토큰 값을 수집하거나 문서화하지 않는다.
- refresh 자동화를 shell hook이나 스킬로 옮기지 않는다.
- monitor job을 끄고 수동 재인증 중심으로 운영하지 않는다.
- provider failure를 모델 교체만으로 숨기지 않는다. 인증/쿼터/네트워크 원인을 별도로 기록한다.
