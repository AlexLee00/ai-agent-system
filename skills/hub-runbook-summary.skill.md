---
name: hub-runbook-summary
description: Summarize Hub operational runbooks, routing state, cost, alarms, and trace evidence without changing live services.
triggers:
  - summarize hub runbook
  - hub operations summary
  - hub trace evidence
permissions:
  - read-only
owner: hub
llm_routing: hub.agent_policy
---

# Hub Runbook Summary

Use this skill to produce a concise read-only summary of Hub state:

- active Hub services and launchd labels;
- LLM routing, cost, cycle, and trace evidence;
- recent alarms and blockers;
- promotion or rollback notes.

Do not restart services, apply migrations, change secrets, or mutate Hub state from this skill.

