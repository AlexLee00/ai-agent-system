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
- [bots/claude/lib/archer/config.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/archer/config.js)

아처 LLM 체인:
- primary: `anthropic / claude-sonnet-4-6`
- fallback: `openai / gpt-4o-mini`
- final fallback: `groq / llama-4-scout-17b-16e-instruct`
- 폴백 순서는 [bots/claude/lib/archer/config.js](/Users/alexlee/projects/ai-agent-system/bots/claude/lib/archer/config.js)의 `LLM_CHAIN`에서 조정한다.

## 자주 쓰는 명령어

```bash
node /Users/alexlee/projects/ai-agent-system/bots/claude/scripts/health-report.js --json
cd /Users/alexlee/projects/ai-agent-system/bots/claude && npm run dexter
cd /Users/alexlee/projects/ai-agent-system/bots/claude && npm run dexter:quick
cd /Users/alexlee/projects/ai-agent-system/bots/claude && npm run dexter:checksums
```

## 클로드팀 에이전트 구성 (2026-06 기준)

클로드팀은 9개 에이전트로 운영된다: commander · dexter · archer · doctor · reviewer · guardian · builder · auto-dev · **refactorer**. (본 문서 상단은 dexter/archer 중심이며, 아래는 git 기준 최근 구현 완료 내역.)

## 구현 완료 내역 (git 기준, 2026-05~06)

- **리팩터러 cycle Phase 1** — `ad4a1229a` feat(claude): add refactorer shadow cycle with sigma feedback
  - `bots/claude/scripts/refactor-cycle-runner.ts` 골격(shadow): 7단계(분석→계획→리팩토링→검증→오류수정→커밋→문서), kill switch `REFACTORER_CYCLE_MODE`(off/shadow/active, 기본 off), active 차단, crypto/PROTECTED 타깃 제외, heartbeat `claude-refactorer` 편입, outcome `meta.kind='refactor'`. shadow=analyze+plan + sigma vault search(읽기) 피드백 주입.
  - protected 판정 trailing-slash 보강(bare 디렉터리도 차단). 단위 테스트 `bots/claude/__tests__/refactor-cycle-runner.test.ts` 6/6.
  - **Phase 2 source plist 추가** — `bots/claude/launchd/ai.claude.refactor-cycle.plist`: shadow-only, 일 1회 03:00, RunAtLoad/KeepAlive=false. 마스터 launchctl 등록 대기.
- **리팩터러 에이전트 + 하네스 신설** — `fb4a8ef55`, `ea52608f5`: agents/refactorer.md + plugin-eval 3계층 + hook 6계층 + MCP `claude-refactor-mcp`(port 8774 상주) + A2A refactor-analysis + CLAUDE.md/plist.
- **@ts-nocheck 복구** — `251f05f13`(Phase 3-A, 소형 A2A 7개), `3d06a81ce`(Phase 3-B, A2A 스킬/훅/하네스 22개) + claude-card 스킬 등록.
- **auto-dev 자가진화 강화** — vault feed `f448de19a`(claude+sigma, auto_dev_outcomes→vault) + self-heal 강화 `c65438534` + main 격리/커밋 경로 `2e61784fc`·`2980a714a`.
- **dexter 안정화** — heartbeat 체크 안정화 `89fb4926c` + soft warning 노이즈 감소 `8fe27fd5f`.
- **인프라 정리** — n8n decommission `2e73df922`·`b225f5deb` + LLM selector OpenAI-first `d0187f2d0`.

## 관련 문서

- [CLAUDE.md](/Users/alexlee/projects/ai-agent-system/CLAUDE.md)
- [bots/claude/CLAUDE_NOTES.md](/Users/alexlee/projects/ai-agent-system/bots/claude/CLAUDE_NOTES.md)
- [TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)
