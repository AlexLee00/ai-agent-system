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
  - **Phase 2 source plist 추가** — `bots/claude/launchd/ai.claude.refactor-cycle.plist`: shadow-only, 일 1회 03:00, RunAtLoad/KeepAlive=false. 이후 Phase 2~3에서 active+apply로 등록·가동(아래 참조).
- **리팩터러 Phase 2~3: active + apply 자율운영 (LIVE, 2026-06-07~08)** — shadow → active → 게이트형 apply → 무인 자율까지 완성.
  - Phase 3 active `ccfa0d78f` + autofix/execution-trajectory 루프 `4ecacedba` + Phase B targeted typecheck `b9093c47c`(최근접 tsconfig+대상파일 진단필터, fail-closed) + dirty-scope 가드 `3a621256b`(`REFACTORER_DIRTY_SCOPE=workspace`).
  - **게이트형 apply (opt-in)** `7b28310a7`: path-scoped 단일 커밋(`git add/commit -- <file>`, -A/-a 금지) + Phase A builder-skip 안전성(tsc 미실행 시 verify 보류, false-accept 차단).
  - **자율운영 레일**(HEAD 반영): push 후 origin 반영 검증(`merge-base --is-ancestor`)→실패 시 rollback, strict 게이트(`tsconfig.strict.json`) 사전 통과, 사이클 락(`.refactorer-active.lock`; deploy/auto-commit도 락 확인), 회당 적용 상한(`REFACTORER_APPLY_MAX_PER_CYCLE`).
  - **첫 자율 적용** `a5f9711`(news-credentials.legacy.ts @ts-nocheck 제거, 1파일/1삭제). **첫 자율 사이클**: validation-adapter.ts TS2339 포착→안전 보류·복원(true-defer). plist active/apply/strict/push 가동, 03:00 스케줄.
  - **학습루프 검증**: outcome→`claude.auto_dev_outcomes`(에러 원문 적재) →(01:40 sigma 일배치)→ `sigma.vault_entries` → `fetchRefactorVaultFeedback` 회수(vaultFeedbackCount=3 실증) + `deriveAvoidedFiles` 회피.
  - **autofix 학습기반 보완**(진행 중·미커밋, 42/42 테스트 검증): 대상 파일 과거 실패(`deriveFilePriorErrors`)를 fixer 프롬프트에 주입(`priorErrors`). 설계 `docs/codex/CODEX_REFACTORER_AUTOFIX_LEARNING_2026-06-08.md`. 관찰검증(apply OFF)→운영 전환 대기.
  - deploy.sh 안전화 `63d74b09b`(dirty/ahead skip, reset는 클린 ff만). 테스트 38(커밋)/42(워크트리).
- **리팩터러 에이전트 + 하네스 신설** — `fb4a8ef55`, `ea52608f5`: agents/refactorer.md + plugin-eval 3계층 + hook 6계층 + MCP `claude-refactor-mcp`(port 8774 상주) + A2A refactor-analysis + CLAUDE.md/plist.
- **@ts-nocheck 복구** — `251f05f13`(Phase 3-A, 소형 A2A 7개), `3d06a81ce`(Phase 3-B, A2A 스킬/훅/하네스 22개) + claude-card 스킬 등록.
- **auto-dev 자가진화 강화** — vault feed `f448de19a`(claude+sigma, auto_dev_outcomes→vault) + self-heal 강화 `c65438534` + main 격리/커밋 경로 `2e61784fc`·`2980a714a`.
- **dexter 안정화** — heartbeat 체크 안정화 `89fb4926c` + soft warning 노이즈 감소 `8fe27fd5f`.
- **인프라 정리** — n8n decommission `2e73df922`·`b225f5deb` + LLM selector OpenAI-first `d0187f2d0`.

## 관련 문서

- [CLAUDE.md](/Users/alexlee/projects/ai-agent-system/CLAUDE.md)
- [bots/claude/CLAUDE_NOTES.md](/Users/alexlee/projects/ai-agent-system/bots/claude/CLAUDE_NOTES.md)
- [TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)
