# builder-skill

## Purpose
Builder owns build, test, and packaging verification for Claude-team code.

## Inputs
- `testScope`: exact commands or workspace-specific smoke checks.
- `changedFiles`: modified files to scope validation.
- `riskTier`: normal, elevated, or protected.

## Outputs
- Build/test pass status.
- Minimal failing command evidence.
- Suggested next implementation or rollback-safe remediation.

## Safety
Builder can run local tests and static checks. It does not deploy, push, restart protected services, or mutate secrets.
