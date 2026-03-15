# Shared Reporting Hub Plan

## Goal

알람과 리포팅이 팀별 `mainbot-client`, 텔레그램 유틸, 브리핑 조립, RAG 저장, n8n escalation에 흩어져 있는 상태를 줄이고,
공용 발행 허브를 통해 같은 이벤트 계약을 지나가게 만든다.

## Current Shared Layer

- [reporting-hub.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/reporting-hub.js)
  - `normalizeEvent()`
  - `publishToQueue()`
  - `publishToTelegram()`

## Applied So Far

- [bots/reservation/lib/mainbot-client.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/mainbot-client.js)
- [bots/investment/shared/mainbot-client.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/mainbot-client.js)
- [bots/claude/lib/mainbot-client.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/mainbot-client.js)
- [bots/reservation/lib/telegram.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/telegram.js)

즉 지금은
- mainbot queue 발행
- 팀 topic 텔레그램 발행
이 같은 이벤트 정규화 레이어를 탄다.

## Next Extraction Targets

1. RAG 저장 연동
- `reservation-rag`
- `rag-safe`
- `blog-rag-store`

2. n8n escalation 연동
- critical webhook
- ska command workflow
- blog pipeline alerts

3. briefing/report fanout
- 야간/아침 브리핑
- daily/weekly report
- 운영 헬스 경고

4. delivery policy
- severity별 채널
- dedupe/throttle
- retry/fallback

## Desired End State

모든 팀 이벤트는 아래 공통 계약을 지나간다.

```js
{
  from_bot,
  team,
  event_type,
  alert_level,
  message,
  payload
}
```

그리고 허브가
- queue
- telegram
- rag
- n8n
- briefing snippet
중 어느 경로로 보낼지 결정한다.
