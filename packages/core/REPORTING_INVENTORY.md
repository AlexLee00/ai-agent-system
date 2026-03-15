# Reporting Inventory

## Goal

전체 시스템의 알림과 리포트를 찾아서, 최종적으로 하나의 공용 파이프라인을 통과하도록 정리하기 위한 inventory.

## Current Producers

### Queue/Mainbot Producers

- [bots/reservation/lib/mainbot-client.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/mainbot-client.js)
- [bots/investment/shared/mainbot-client.js](/Users/alexlee/projects/ai-agent-system/bots/investment/shared/mainbot-client.js)
- [bots/claude/lib/mainbot-client.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/mainbot-client.js)

### Direct Telegram Producers

- [bots/reservation/lib/telegram.js](/Users/alexlee/projects/ai-agent-system/bots/reservation/lib/telegram.js)
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

## Current Shared Pipeline Layer

- [packages/core/lib/reporting-hub.js](/Users/alexlee/projects/ai-agent-system/packages/core/lib/reporting-hub.js)
  - event normalization
  - queue publish
  - telegram publish
  - rag publish
  - n8n publish
  - multi-target pipeline fanout
  - shared snippet formatting
  - shared notice formatting

## Applied So Far

- reservation mainbot queue path → reporting-hub
- investment mainbot queue path → reporting-hub
- claude telegram alert path → reporting-hub
- reservation direct telegram path → reporting-hub
- rag-safe degraded/recovered queue alerts → reporting-hub
- claude reporter telegram alerts/reports → reporting-hub
- luna reporter queue fanout → reporting-hub
- night-handler briefing snippets → reporting-hub event contract
- dexter alert/recovery wording → reporting-hub notice format
- luna queue report/accuracy alert → reporting-hub notice/report format
- rebecca daily/weekly text report → shared python report format

## Next Moves

1. `rebecca`와 기타 reporter 경로를 reporting-hub fanout으로 통일
2. severity, dedupe, throttle, quiet-hours 정책을 reporting-hub로 승격
3. reservation/blog/investment RAG 저장도 reporting-hub target 조합으로 흡수
4. reporter/rebecca/night-handler 문구를 공용 notice/report formatter로 추가 통일
5. mainbot consumer도 envelope/target 기반으로 일반화
