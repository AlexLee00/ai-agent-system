# Shared Reporting Hub Plan

## Goal

알람과 리포팅이 팀별 `alert-publisher`/호환 alias, 텔레그램 유틸, 브리핑 조립, RAG 저장, n8n escalation에 흩어져 있는 상태를 줄이고,
공용 발행 허브를 통해 같은 이벤트 계약을 지나가게 만든다.

## Current Shared Layer

- [reporting-hub.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/reporting-hub.js)
  - `normalizeEvent()`
  - `validatePayloadSchema()`
  - payload warning telemetry (`/tmp/reporting-payload-warnings.jsonl`)
  - `publishToQueue()`
  - `publishToTelegram()`
  - `publishToRag()`
  - `publishToN8n()`
  - `publishEventPipeline()`
  - shared notice/report/snippet formatting
  - delivery policy (`dedupe`, `cooldown`, `quietHours`)
  - payload schema normalization / warning / telemetry

## Applied So Far

- [bots/reservation/lib/alert-client.ts](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/alert-client.ts)
- [bots/investment/shared/alert-publisher.ts](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/alert-publisher.ts)
- [bots/claude/lib/alert-publisher.ts](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/alert-publisher.ts)
- [bots/reservation/lib/telegram.ts](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/telegram.ts)
- [packages/core/scripts/publish-python-report.js](/Users/alexlee/projects/ai-agent-system/packages/core/scripts/publish-python-report.js)
- [bots/investment/shared/rag-client.ts](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/rag-client.ts)
- [bots/blog/lib/publ.ts](/Users/alexlee/projects/ai-agent-system/bots/blog/lib/publ.ts)
- [bots/blog/lib/rag-accumulator.ts](/Users/alexlee/projects/ai-agent-system/bots/blog/lib/rag-accumulator.ts)
- [bots/investment/scripts/weekly-trade-review.ts](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.ts)
- [bots/investment/scripts/analyze-rr.ts](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/analyze-rr.ts)
- [bots/investment/scripts/analyze-signal-correlation.ts](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/analyze-signal-correlation.ts)
- [bots/orchestrator/src/sigma-daily.ts](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/sigma-daily.ts)
- [bots/orchestrator/lib/sigma/sigma-feedback.ts](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/sigma/sigma-feedback.ts)
- [bots/video/lib/video-rag.ts](/Users/alexlee/projects/ai-agent-system/bots/video/lib/video-rag.ts)
- [bots/worker/web/server.js](/Users/alexlee/projects/ai-agent-system/bots/worker/web/server.js)
- [bots/claude/lib/doctor.ts](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/doctor.ts)

즉 지금은
- alert publisher 발행
- 팀 topic 텔레그램 발행
- Python 리포터 stdout 브릿지
- investment current RAG 저장
- investment review/analysis RAG 저장
- sigma daily/meta-review RAG 저장
- video edit result/feedback RAG 저장
- worker document/journal/schedule RAG 저장
- claude doctor recovery/failure RAG 저장
- blog publish / performance RAG 저장
- blog post/quality accumulation RAG 저장
 이 같은 이벤트 정규화 레이어를 탄다.

## Next Extraction Targets

1. RAG 저장 연동
- `reservation-rag`
- `rag-safe`
- `blog-rag-store`
- `blog publ direct rag.store(...)` 대부분 정리
- `blog rag-accumulator direct rag.store(...)` 정리

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
- quiet-hours suppression
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

권장 `payload` 표준 키:

```js
{
  title,      // 짧은 제목
  summary,    // 한 줄 요약
  details,    // 상세 라인 배열
  action,     // 권장 조치
  links,      // [{ label, href }]
  detail      // 단일 상세 문자열 (legacy 호환)
}
```

그리고 허브가
- queue
- telegram
- rag
- n8n
- briefing snippet
중 어느 경로로 보낼지 결정한다.
