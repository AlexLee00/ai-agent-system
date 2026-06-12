#!/usr/bin/env bash

BRANCH_GUARD_OPS_ROOT="/Users/alexlee/projects/ai-agent-system"
BRANCH_GUARD_EXPECTED_BRANCH="main"

branch_guard_realpath() {
  local target="$1"
  if [ -z "$target" ]; then
    return 1
  fi
  (cd "$target" 2>/dev/null && pwd -P)
}

branch_guard_current_branch() {
  git -C "$1" branch --show-current 2>/dev/null || true
}

branch_guard_should_skip() {
  local worktree_path="$1"
  local branch="$2"
  local ops_root actual_root

  ops_root="$(branch_guard_realpath "$BRANCH_GUARD_OPS_ROOT")" || return 1
  actual_root="$(branch_guard_realpath "$worktree_path")" || return 1

  [ "$actual_root" = "$ops_root" ] && [ "$branch" != "$BRANCH_GUARD_EXPECTED_BRANCH" ]
}

branch_guard_message() {
  printf 'BRANCH_GUARD skip: root worktree on %s, expected %s\n' "${1:-unknown}" "$BRANCH_GUARD_EXPECTED_BRANCH"
}

branch_guard_require_ops_main() {
  local worktree_path="$1"
  local branch

  if [ "${BRANCH_GUARD_DISABLED:-false}" = "true" ]; then
    return 0
  fi

  branch="$(branch_guard_current_branch "$worktree_path")"
  if [ -z "$branch" ]; then
    branch="detached"
  fi

  if branch_guard_should_skip "$worktree_path" "$branch"; then
    branch_guard_message "$branch"
    exit 0
  fi
}
