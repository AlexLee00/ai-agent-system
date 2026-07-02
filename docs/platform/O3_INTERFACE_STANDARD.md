# O3 Interface Standard

O3-facing interfaces must be easy to discover, route, and audit.

## Skill Frontmatter

Every active skill should start with YAML frontmatter:

```yaml
---
name: stable-skill-name
description: One sentence describing when to use it.
triggers:
  - concrete user phrase
  - domain keyword
permissions:
  - read-only
owner: team-name
llm_routing: selector.key
---
```

Required fields are `name`, `description`, and `triggers`. `permissions`, `owner`, and `llm_routing` are optional but recommended for operational skills.

## A2A Cards And MCP Tools

- A2A cards must expose stable `name`, `description`, and endpoint or capability metadata.
- MCP tools must use concise action descriptions and say when the tool is read-only.
- Noncompliance is report-only until each team has an owner-approved cleanup window.

## Archive Policy

Stale skills are moved under `skills/archive/` instead of being deleted. Archived skills do not participate in active routing and should not be used for new automation.

