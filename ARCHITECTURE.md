# ai-agent-system Architecture

This document fixes the boundary between the tools around this repository and the runtime system inside it. Keep this distinction stable when reorganizing docs or adding team guidance.

## Three Layers

### 1. Claude Code (`.claude/`)

Claude Code is treated as a legacy and optional development helper layer.

- Scope: planning aids, verification loops, code review patterns, debugging helpers, and MCP-related experiments.
- Location: `.claude/skills`, `.claude/hooks`, `.claude/rules`, and older bot-level `CLAUDE.md` files.
- Direction: keep useful development patterns, but do not let `.claude/` become the canonical source of team operating context.
- Runtime impact: none by default. Moving or editing `.claude/` assets must not affect launchd services or live team processes.

### 2. OpenAI Codex (`AGENTS.md`)

`AGENTS.md` is the canonical implementation guidance surface for this repository.

- Scope: how Codex and Claude Code should work inside each repo or bot directory.
- Root file: `AGENTS.md` defines repository-wide session rules and implementation discipline.
- Bot files: `bots/*/AGENTS.md` define team-specific context, protected processes, core files, verification commands, and operational warnings.
- Direction: when a bot has both `AGENTS.md` and `CLAUDE.md`, the `AGENTS.md` file is the source of truth. `CLAUDE.md` should eventually become a pointer or be retired after explicit approval.

### 3. Local Runtime System (`bots/`, `packages/`, launchd, DB)

The local runtime system is the product being operated.

- Scope: agents, team runtimes, shared libraries, launchd jobs, Hub API, MCP servers, PostgreSQL schemas, reports, and dashboards.
- Main code paths: `bots/`, `packages/core/lib`, `scripts/`, per-bot `bots/<team>/launchd/`, and migrations.
- Direction: code and runtime changes must be verified by the relevant unit, smoke, dry-run, shadow, or read-only runtime checks before being reported as complete.
- Safety: live trading, real publishing, external notifications, secret changes, launchd restarts, DB writes, and protected process changes require explicit master approval.

## Operating Roles

- **Meti (Claude app)**: strategy, design, review, independent verification, and implementation prompts. Does not directly edit runtime code.
- **Codex (OpenAI Codex)**: file creation/modification, tests, smoke checks, dry-runs, and implementation reports.
- **Master (Jay)**: final approval, git commit/push, launchd changes, DB writes, secret changes, live toggles, and operational cutovers.

Standard flow:

```text
Meti design -> Codex implementation -> Meti verification -> Master approval
```

## Team Entry Point Policy

- Every active bot should have a focused `bots/<team>/AGENTS.md`.
- Generic assistant templates do not belong in team AGENTS files.
- Team AGENTS files should include:
  1. role boundary,
  2. protected operations,
  3. team structure,
  4. core files,
  5. current state,
  6. operational warnings,
  7. shared utility requirements,
  8. verification harness.
- Existing `CLAUDE.md` files are useful source material, but not the canonical runtime guidance once `AGENTS.md` exists.

## Protected Operations

Do not perform these without explicit master approval:

- live trade or live-fire cutover,
- real post/comment/notification sending,
- launchd bootstrap, bootout, kickstart, kill, unload, or protected PID restart,
- secret changes,
- DB write or migration apply,
- destructive git commands,
- commit or push,
- rollback of operational state.

## Documentation Cleanup Order

1. Fix entry points first: bot-level `AGENTS.md`.
2. Keep this architecture boundary current.
3. Archive completed `docs/codex` prompts and obsolete trackers gradually.
4. Avoid large documentation moves that mix current runtime guidance with historical records.

## Current Focus

As of 2026-06-26, the cleanup priority is:

1. replace copied generic bot AGENTS templates with real team context,
2. add missing AGENTS files for active bots,
3. decide whether to pointerize or retire bot-level `CLAUDE.md`,
4. then clean accumulated markdown archives in smaller batches.
