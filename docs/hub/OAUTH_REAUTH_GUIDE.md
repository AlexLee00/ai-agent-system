# Claude Code OAuth 재인증 가이드

## 개요

Claude Code OAuth 토큰은 주기적으로 만료됩니다. 토큰 만료 시 LLM 호출이 Groq 폴백으로 자동 전환되지만,
가능한 한 빨리 재인증하여 Claude 모델 품질을 복구해야 합니다.

---

## 알림 시나리오

### 24시간 전 경고
`ai.hub.llm-oauth-monitor` (매 6시간 실행)가 만료 24시간 전 감지 시:

```
[oauth] 토큰 갱신 필요: 23.5h 후 만료
```

이때 `/tmp/hub-llm-oauth-monitor.log`에서 확인 가능하며, Hub가 경고 알림을 발송합니다.

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
claude auth login
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

## 자동화가 불가능한 이유

Claude Code OAuth는 브라우저 기반 OAuth 2.0 흐름을 사용합니다.
- 사람의 브라우저 인터랙션이 필수 (자동 클릭 불가)
- Anthropic의 보안 정책상 headless 인증 미지원
- 토큰 갱신(refresh token)이 제공되지 않는 구조

따라서 주기적 수동 재인증이 필요하며, 모니터 알림을 통해 사전에 대비해야 합니다.

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
