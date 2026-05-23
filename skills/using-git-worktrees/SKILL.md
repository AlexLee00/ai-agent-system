---
name: using-git-worktrees
description: 병렬 개발, dirty main 보호, auto-dev 격리 작업이 필요할 때 git worktree를 안전하게 사용하는 절차.
---

# Using Git Worktrees

## 목적

main worktree에 사용자 변경이 있거나 여러 작업을 병렬로 진행할 때, 변경 범위를 격리해 오염을 막는다.

## 절차

1. 현재 상태 확인: `git status --short`로 dirty 파일을 기록한다.
2. 범위 판단: 현재 작업이 기존 변경과 섞이면 위험한지 판단한다.
3. worktree 생성: 별도 경로와 `codex/` 또는 작업 전용 branch를 사용한다.
4. 구현/검증: worktree 내부에서만 수정하고 테스트한다.
5. 결과 반영: patch, PR, 또는 명시 승인된 merge 방식으로만 반영한다.
6. 정리: 안전한 상태인지 확인한 뒤에만 worktree를 제거한다.

## 팀 제이 규칙

- 사용자 변경을 `git checkout --`, `git reset --hard`로 정리하지 않는다.
- main worktree가 dirty이면 신규 구현은 격리 우선이다.
- worktree 제거 전 `git status --short`가 비어 있는지 확인한다.
- 자동 commit/push는 별도 명시 승인 없이는 하지 않는다.

## 권장 명령 패턴

```bash
git status --short
git worktree add ../ai-agent-system-<task> -b codex/<task>
git -C ../ai-agent-system-<task> status --short
```
