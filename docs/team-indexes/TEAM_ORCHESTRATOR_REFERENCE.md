# 제이/오케스트레이터 참조 문서

## 역할

- 메인봇 라우팅
- 팀별 헬스/리포트/인텐트/브리핑 허브

## 핵심 기능

- 자연어 명령 라우팅
- 팀별 상태 요약
- n8n critical path 점검
- 인텐트/피드백/리포팅 조회

## 핵심 진입점

- [bots/orchestrator/src/router.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/src/router.js)
- [bots/orchestrator/lib/intent-parser.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/intent-parser.js)

## 운영 스크립트/설정

- [bots/orchestrator/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/health-report.js)
- [bots/orchestrator/scripts/check-n8n-critical-path.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/check-n8n-critical-path.js)
- [bots/orchestrator/config.json](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/config.json)
- [bots/orchestrator/lib/runtime-config.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/runtime-config.js)

## 자주 쓰는 명령어

```bash
node /Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/health-report.js --json
node /Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/check-n8n-critical-path.js
node /Users/alexlee/projects/ai-agent-system/scripts/reviews/jay-llm-daily-review.js --days=1
```

## 관련 문서

- [bots/orchestrator/context/DEV_SUMMARY.md](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/context/DEV_SUMMARY.md)
- [bots/orchestrator/context/HANDOFF.md](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/context/HANDOFF.md)
- [bots/orchestrator/context/TEAMS.md](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/context/TEAMS.md)
