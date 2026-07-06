---
name: hub-ops
description: Hub routing, resilience, alarm lifecycle, and Sigma feedback operations.
triggers:
  - hub routing debug
  - model selection
  - alarm lifecycle
  - resilience runbook
---

# Hub Ops

Use this skill when inspecting Hub LLM routing, provider fallback, alarm lifecycle, or Hub-to-Sigma feedback.

## Routing Table

| Need | Command doc |
| --- | --- |
| Explain selector chain | `commands/routing-debug.md` |
| Choose or compare model class | `commands/model-selection.md` |
| Inspect alarm dedupe and TTL | `commands/alarm-triage.md` |
| Review circuit and fallback behavior | `commands/resilience-runbook.md` |
| Avoid known remodel pitfalls | `commands/gotchas.md` |

## Safety

- Read-only first: health, selector, circuit, routing log SELECT.
- Do not restart `ai.hub.*` from this skill.
- Do not apply migrations from this skill.
- Do not enable active auto-routing from this skill.
- Treat crypto LIVE and SKA paths as protected.

## Outputs

- State the selector key, runtime profile, routing source, and fallback count.
- Separate current behavior from gated future behavior.
- Mention whether DB columns or env gates are absent.
