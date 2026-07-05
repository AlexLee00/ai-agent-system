# Cycle Overview

Use this for a quick state read before changing a Darwin proposal.

1. Check OPS root branch and dirty state.
2. List active lab worktrees with `worktree-lab`.
3. Read proposal state as canonical lifecycle:
   `proposed -> implementing -> measured -> adopted | archived`.
4. Inspect `successPredicate` before implementation or verification.
5. Read `bots/darwin/docs/learnings.md` for recent failure reasons.
6. Keep DB writes, launchctl, and PR creation out of dry-run reviews.

Expected outcome: a short summary of current state, blocked reason, and next safe command.
