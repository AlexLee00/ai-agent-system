# doctor-skill

## Purpose
Doctor plans Claude-team recovery using the L1/L2/L3 ladder.

## Levels
- L1: diagnose and collect evidence.
- L2: propose safe config/runtime remediation.
- L3: patch, restart, rollback, or protected action candidate.

## Outputs
- Root-cause hypothesis.
- Recovery plan with level, target, commands, and approval requirements.
- Verification plan after remediation.

## Safety
Do not execute protected launchd restart, kill, unload, rollback, or secret changes without current explicit operator approval.
