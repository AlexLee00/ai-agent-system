# Gotchas

- Do not checkout a `darwin/*` branch in the OPS root.
- A proposal without `successPredicate` must not enter implementation.
- Static checks are evidence, but predicate assertions decide VERIFY.
- Failed predicate verification keeps status `implementing`; it does not auto-archive.
- Archive stale proposals through triage evidence, not ad hoc status writes.
- D5 Elixir V2 shadow/evaluator/ESPL is frozen by default.
- Sigma findings hook is advisory; queue fallback is expected when Sigma MCP lacks write tools.
- Weekly reports are read-only unless explicitly sending alarms outside dry-run.
