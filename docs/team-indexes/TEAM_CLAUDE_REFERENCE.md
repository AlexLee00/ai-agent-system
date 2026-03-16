# 클로드/덱스터 참조 문서

## 역할

- 시스템 점검, 기술 인텔리전스, 패치 감지/리포팅

## 핵심 기능

- `dexter` 전체 점검
- `dexter-quickcheck` 빠른 감시
- `archer` 기술/패치 분석

## 핵심 진입점

- [bots/claude/src/dexter.js](/Users/alexlee/projects/ai-agent-system/bots/claude/src/dexter.js)
- [bots/claude/src/dexter-quickcheck.js](/Users/alexlee/projects/ai-agent-system/bots/claude/src/dexter-quickcheck.js)
- [bots/claude/src/archer.js](/Users/alexlee/projects/ai-agent-system/bots/claude/src/archer.js)

## 핵심 체크 모듈

- [bots/claude/lib/checks/bots.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/checks/bots.js)
- [bots/claude/lib/checks/resources.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/checks/resources.js)
- [bots/claude/lib/checks/database.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/checks/database.js)
- [bots/claude/lib/checks/n8n.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/checks/n8n.js)
- [bots/claude/lib/checks/patterns.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/checks/patterns.js)

## 운영 스크립트/설정

- [bots/claude/scripts/health-report.js](/Users/alexlee/projects/ai-agent-system/bots/claude/scripts/health-report.js)
- [bots/claude/config.json](/Users/alexlee/projects/ai-agent-system/bots/claude/config.json)
- [bots/claude/lib/config.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/config.js)

## 자주 쓰는 명령어

```bash
node /Users/alexlee/projects/ai-agent-system/bots/claude/scripts/health-report.js --json
cd /Users/alexlee/projects/ai-agent-system/bots/claude && npm run dexter
cd /Users/alexlee/projects/ai-agent-system/bots/claude && npm run dexter:quick
cd /Users/alexlee/projects/ai-agent-system/bots/claude && npm run dexter:checksums
```

## 관련 문서

- [CLAUDE.md](/Users/alexlee/projects/ai-agent-system/CLAUDE.md)
- [bots/claude/CLAUDE_NOTES.md](/Users/alexlee/projects/ai-agent-system/bots/claude/CLAUDE_NOTES.md)
- [TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)
