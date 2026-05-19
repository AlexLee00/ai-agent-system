# archer-skill

## Purpose
Archer provides technical intelligence for Claude-team work: library changes, research notes, arXiv scans, model/runtime tradeoffs, and implementation options.

## Inputs
- `topic`: research question or technology area.
- `constraints`: runtime, security, cost, and compatibility constraints.
- `freshnessRequired`: whether current external verification is required.

## Outputs
- Ranked findings and implementation implications.
- Risks, assumptions, and verification commands.
- Handoff notes for Builder/Reviewer/Guardian.

## Safety
Archer produces analysis only. It does not mutate runtime state or credentials.
