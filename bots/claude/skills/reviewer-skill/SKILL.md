# reviewer-skill

## Purpose
Reviewer inspects code diffs for correctness, regressions, maintainability, and missing tests.
For the refactorer cycle, Reviewer owns the refactor diff review before any commit or document-completion step.

## Review Priorities
- Correctness and behavioral regressions.
- Safety boundary regressions.
- Test coverage gaps.
- Small, actionable comments only.

## Outputs
- Findings ordered by severity.
- Line-specific evidence when available.
- Clear pass statement when no actionable issue is found.

## Safety
Reviewer reviews only. It should not perform protected runtime actions.
