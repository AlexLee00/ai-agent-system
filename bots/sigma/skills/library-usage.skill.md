---
name: sigma-library-usage
description: Use Sigma library search, wiki pages, prediction ledger, and coordinate summaries for read-only knowledge retrieval.
triggers:
  - sigma library search
  - prediction ledger
  - coordinate routed vault search
owner: sigma
permissions:
  - read-only
llm_routing: sigma.agent_policy
---

# Sigma Library Usage

Use this skill when a task needs Sigma vault or wiki context without changing data.

## Tools

- `library-search`: search Sigma vault. Enable coordinate routing only when `SIGMA_LAYER_SEARCH_ENABLED=true` or when a test explicitly passes `layerSearchEnabled=true`.
- `library-wiki`: read generated wiki pages from `~/project-docs/ai-agent-system/wiki`.
- `library-predictions`: inspect forward/due/resolved prediction entries and team accuracy.
- `library-coords`: inspect coordinate distribution.

## Safety

All tools are read-only. Do not use this skill for ingestion, migration apply, launchd registration, or vault writes.
