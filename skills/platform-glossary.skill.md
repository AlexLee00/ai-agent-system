---
name: platform-glossary
description: Define Team Jay platform terms such as PGE, harness, cycle, trace, shadow, promotion gate, and protected operations.
triggers:
  - platform glossary
  - explain team jay terms
  - what does promotion gate mean
permissions:
  - read-only
owner: platform
llm_routing: hub.agent_policy
---

# Platform Glossary

- P/G/E: Planner, Generator, Evaluator roles in an autonomous harness.
- Harness: the bounded workflow that plans, produces, evaluates, and records a result.
- Cycle: one bounded execution attempt with a traceable objective.
- Trace: cross-system identifier used to connect Hub calls, alarms, and event records.
- Shadow: observe or simulate without mutating live state.
- Promotion gate: evidence checklist before master review or activation.
- Protected operation: launchd, DB write, secret, live trade, revenue, or deployment action that needs explicit approval.

