# Reporting Inventory

## Goal

전체 시스템의 알림과 리포트를 찾아서, 최종적으로 하나의 공용 파이프라인을 통과하도록 정리하기 위한 inventory.

## Current Producers

### Queue/Alert Producers

- [bots/reservation/lib/alert-client.ts](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/alert-client.ts)
- [bots/investment/shared/alert-publisher.ts](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/alert-publisher.ts)
- [bots/claude/lib/alert-publisher.ts](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/alert-publisher.ts)

### Direct Telegram Producers

- [bots/reservation/lib/telegram.ts](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/telegram.ts)
- [packages/core/lib/telegram-sender.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/telegram-sender.js)
- [bots/orchestrator/src/mainbot.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/mainbot.js)

### RAG Writers

- [packages/core/lib/rag-safe.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/rag-safe.js)
- [packages/core/lib/reservation-rag.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/reservation-rag.js)
- [packages/core/lib/blog-rag-store.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/blog-rag-store.js)
- [bots/investment/nodes/l33-rag-store.js](/Users/alexlee/projects/ai-agent-system/bots/investment/nodes/l33-rag-store.js)
- [bots/ska/src/rebecca.py](/Users/alexlee/projects/ai-agent-system/bots/ska/src/rebecca.py)

### n8n Escalation/Delivery

- [packages/core/lib/n8n-runner.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/n8n-runner.js)
- [bots/orchestrator/n8n/setup-n8n.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/n8n/setup-n8n.js)
- [bots/reservation/context/n8n-ska-command-workflow.json](/Users/alexlee/projects/ai-agent-system/bots/reservation/context/n8n-ska-command-workflow.json)
- [bots/blog/api/n8n-workflow.json](/Users/alexlee/projects/ai-agent-system/bots/blog/api/n8n-workflow.json)

### Briefing/Report Aggregators

- [bots/orchestrator/lib/night-handler.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/night-handler.js)
- [bots/claude/lib/reporter.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/reporter.js)
- [bots/investment/team/reporter.js](/Users/alexlee/projects/ai-agent-system/bots/investment/team/reporter.js)
- [packages/core/scripts/publish-python-report.js](/Users/alexlee/projects/ai-agent-system/packages/core/scripts/publish-python-report.js)

## Current Shared Pipeline Layer

- [packages/core/lib/reporting-hub.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/reporting-hub.js)
  - event normalization
  - payload normalization (`title/summary/details/action/links`)
  - payload validation warning (`validatePayloadSchema`)
  - payload warning telemetry (`/tmp/reporting-payload-warnings.jsonl`)
  - queue publish
  - telegram publish
  - rag publish
  - n8n publish
  - multi-target pipeline fanout
  - shared snippet formatting
  - shared notice formatting
  - shared delivery policy (dedupe/throttle/quiet-hours)

## Applied So Far

- reservation mainbot queue path → reporting-hub
- investment mainbot queue path → reporting-hub
- luna-commander queue alerts → reporting-hub
- claude telegram alert path → reporting-hub
- reservation direct telegram path → reporting-hub
- rag-safe degraded/recovered queue alerts → reporting-hub
- claude reporter telegram alerts/reports → reporting-hub
- luna reporter queue fanout → reporting-hub
- night-handler briefing snippets → reporting-hub event contract
- dexter alert/recovery wording → reporting-hub notice format
- luna queue report/accuracy alert → reporting-hub notice/report format
- rebecca daily/weekly text report → shared python report format
- rebecca daily/weekly delivery → reporting-hub telegram fanout bridge
- ska forecast/review delivery → shared python reporting bridge
- reservation/claude/investment 기본 cooldown 정책 적용
- claude 저우선 안내 quiet-hours 정책 적용
- claude alert fanout → severity 기반 telegram/n8n 라우팅
- reservation mainbot/telegram → severity 기반 queue/n8n 및 telegram/n8n 라우팅
- luna direct telegram alerts/reports → severity 기반 telegram/n8n 라우팅
- blog health-check alerts → severity 기반 telegram/n8n 라우팅
- luna health-check alerts → reporting-hub notice + severity fanout
- luna optimize-ta alerts → investment alert-publisher → reporting-hub webhook fanout
- luna sweeper alerts → investment alert-publisher → reporting-hub webhook fanout
- luna reporter daily/accuracy alerts → investment alert-publisher → reporting-hub webhook fanout
- worker health-check alerts → reporting-hub notice + severity fanout
- worker claude-api-monitor alerts → reporting-hub notice + severity fanout
- worker approval request telegram alerts → reporting-hub telegram_api target
- dexter autofix blocked-action alerts → reporting-hub notice + severity fanout
- shared telegram reporter wrapper → reporting-hub webhook fanout
- shared telegram sender current fanout → reporting-hub webhook fanout
- file-guard blocked-write alerts → reporting-hub webhook fanout
- reservation RAG writes → reporting-hub rag target
- luna L33 trade RAG write → reporting-hub rag target
- investment shared rag-client store → reporting-hub rag target
- investment review/analysis script RAG writes → shared rag-client → reporting-hub rag target
- sigma daily/meta-review RAG writes → reporting-hub rag target
- video edit result/feedback RAG writes → reporting-hub rag target
- worker document/journal/schedule RAG writes → reporting-hub rag target
- claude doctor recovery/failure RAG writes → reporting-hub rag target
- ska python rebecca/forecast RAG writes → reporting-hub rag target (fallback direct insert retained)
- blog publ RAG writes → reporting-hub rag target
- blog rag accumulator RAG writes → reporting-hub rag target
- blog curriculum notices → reporting-hub notice + severity fanout
- blog daily report and failure notice → reporting-hub report/notice format
- orchestrator write reports → reporting-hub webhook fanout
- sigma daily/meta-review alerts → reporting-hub webhook fanout
- reboot notices → reporting-hub webhook fanout
- disaster recovery completion alert → reporting-hub webhook fanout
- orchestrator batch formatter → 공용 notice/snippet 서식 정렬
- orchestrator queue consumer → payload headline/detail 우선 사용
- dexter/luna producer payload → 표준 `title/summary/details/action` 키 적용 시작
- archer patch report payload → 표준 `title/summary/details/action/links` 키 적용
- orchestrator health → reporting payload schema warning 노출
- reporting health direct view → `/reporting-health`
- reporting health summary view → `/reporting-health summary`
- reporting producer ranking view → `/reporting-health producers`
- morning briefing extras → reporting payload warning snippet 포함
- mainbot single alerts → payload link inline buttons 지원

## Next Moves

1. blog current `postAlarm(...)` surface를 별도 배치로 정리
2. severity, dedupe, throttle, quiet-hours 정책을 reporting-hub로 승격
3. remaining `rag.store(...)` matches are now mostly helper adapters, shared-client aliases, search-only consumers, or test/legacy paths; keep pruning non-current surfaces while reporting-hub remains the canonical current write path
4. reporter/rebecca/night-handler 문구를 공용 notice/report formatter로 추가 통일
5. canonical transport (`hub-alarm-client.ts`, `reporting-hub.ts`) 바깥 non-blog current delivery는 사실상 1차 정리 완료 상태로 유지

## Current Output Insight Helpers

reporting-hub 정리와 병행해서, human-facing CLI/report outputs에는 additive한 `aiSummary` / `🔍 AI:` helper rollout도 진행 중이다.

- [bots/reservation/lib/cli-insight.ts](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/cli-insight.ts)
  - pickko reservation/report/admin/diagnostic/payment outputs
- [bots/investment/shared/cli-insight.ts](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/cli-insight.ts)
  - balance/price/transfer outputs
- [bots/worker/lib/cli-insight.legacy.js](/Users/alexlee/projects/ai-agent-system/bots/worker/lib/cli-insight.legacy.js)
  - expense import / n8n intake outputs
- [bots/video/lib/cli-insight.js](/Users/alexlee/projects/ai-agent-system/bots/video/lib/cli-insight.js)
  - n8n path / final structure gap outputs
- [bots/blog/lib/cli-insight.ts](/Users/alexlee/projects/ai-agent-system/bots/blog/lib/cli-insight.ts)
  - n8n pipeline / weekly evolution / performance outputs

공통 규칙:
- 기존 JSON/텍스트 계약 유지
- `aiSummary` 또는 `🔍 AI:`를 additive하게 부착
- `team / gemma-insight` runtime 사용
- sanitize + deterministic fallback 포함

## Current Critical Incident Canonicalization

반복되는 고심각 인프라 알림은 이제 팀별 개별 구현보다 공용 helper 기준으로 통합된다.

- [packages/core/lib/critical-incident.ts](/Users/alexlee/projects/ai-agent-system/packages/core/lib/critical-incident.ts)
- [packages/core/lib/critical-incident.legacy.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/critical-incident.legacy.js)

적용 팀:
- reservation
- investment
- blog
- worker
- claude

의미:
- 같은 유형의 `alert_level >= 3` 인프라성 알림은 대표 incident 1건만 유지
- 이후 유사 이벤트는 새 텔레그램/queue alert를 쌓지 않고, incident metadata만 누적
- 비즈니스 건별 실패 알림은 그대로 유지해서 민감한 개별 사건은 묶지 않음
