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
- [bots/ska/lib/rag_client.py](/Users/alexlee/projects/ai-agent-system/bots/ska/lib/rag_client.py)
- [bots/investment/team/reporter.ts](/Users/alexlee/projects/ai-agent-system/bots/investment/team/reporter.ts)
- [bots/investment/team/sweeper.ts](/Users/alexlee/projects/ai-agent-system/bots/investment/team/sweeper.ts)
- [bots/investment/scripts/health-check.ts](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-check.ts)
- [bots/investment/scripts/optimize-ta-params.ts](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/optimize-ta-params.ts)
- [packages/core/lib/telegram/reporter.ts](/Users/alexlee/projects/ai-agent-system/packages/core/lib/telegram/reporter.ts)
- [packages/core/lib/file-guard.ts](/Users/alexlee/projects/ai-agent-system/packages/core/lib/file-guard.ts)
- [bots/orchestrator/src/write.ts](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/write.ts)
- [packages/core/lib/telegram-sender.ts](/Users/alexlee/projects/ai-agent-system/packages/core/lib/telegram-sender.ts)
- [scripts/pre-reboot.sh](/Users/alexlee/projects/ai-agent-system/scripts/pre-reboot.sh)
- [scripts/post-reboot.sh](/Users/alexlee/projects/ai-agent-system/scripts/post-reboot.sh)
- [scripts/disaster-recovery.sh](/Users/alexlee/projects/ai-agent-system/scripts/disaster-recovery.sh)

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
- ska python rebecca/forecast RAG 저장
- blog publish / performance RAG 저장
- blog post/quality accumulation RAG 저장
- investment ops / reporter / sweeper current fanout
- orchestrator write / sigma current webhook fanout
- shared reporter / file-guard webhook fanout
- shared telegram sender current fanout
- reboot / recovery notice current fanout
 이 같은 이벤트 정규화 레이어를 탄다.

최근 재집계 기준으로 남는 `rag.store(...)` 매치의 대부분은 아래에 해당한다.
- `publishToRag(...)` 내부에서 최종 저장을 수행하는 adapter/helper 구현
- migrated shared client를 `rag` 이름으로 import한 current caller
- search-only consumer (`rag.search(...)`, `_rag.search(...)`)
- test/legacy/js compatibility rail

즉 current production write의 canonical path는 실질적으로 reporting-hub 쪽으로 올라온 상태다.

최근 재집계 기준으로 남는 non-legacy current direct `postAlarm(...)`는 사실상 아래 둘로 압축된다.
- blog current surface
- canonical transport 자체 (`hub-alarm-client.ts`, `reporting-hub.ts`)

즉 blog current fanout을 별도 배치로 다루면, non-blog current delivery는 사실상 reporting-hub rail 정리 1차가 닫힌 상태다.

최근 reinforcement 배치에서는 delivery fanout 자체와 별개로, human-facing output에도 additive한 요약 레일을 깔고 있다.
- reservation: `bots/reservation/lib/cli-insight.ts`
- investment: `bots/investment/shared/cli-insight.ts`
- worker: `bots/worker/lib/cli-insight.legacy.js`
- video: `bots/video/lib/cli-insight.js`
- blog: `bots/blog/lib/cli-insight.ts`

이 helper들은 reporting-hub를 직접 대체하지는 않지만, 같은 `team / gemma-insight` 런타임을 통해
- 한 줄 AI 요약
- sanitize
- deterministic fallback
을 공통화하고, JSON/텍스트 결과 표면에 additive하게 얹는다.

즉 현재 shared reinforcement는 두 축으로 진행 중이다.
- delivery canonicalization: reporting-hub
- operator-facing output reinforcement: team CLI insight helpers

최근 reinforcement에서는 여기에 세 번째 축이 추가됐다.
- ownership / critical incident normalization:
  - launchd vs PortAgent canonical owner 정리
  - repeated critical infra alerts를 대표 incident 1건으로 통합

현재 incident canonicalization이 공용 helper 기반으로 적용된 팀:
- reservation
- investment
- blog
- worker
- claude

즉 같은 계열의 고심각 `system_error`/health alert는
- 새 알림을 계속 쌓지 않고
- canonical incident 1건에 `count / first_seen / last_seen / latest_reason`만 누적
하는 방향으로 수렴했다.

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
- current low-risk direct webhook caller는 investment/orchestrator/core shared rail 위주로 계속 축소 중

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
