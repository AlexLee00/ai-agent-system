# Adopt Review

Use this after a proposal reaches `measured`.

Checklist:

- Proposal state is canonical `measured`.
- All predicate assertion results are `ok: true`.
- Changed files are present and outside the denylist.
- Budget evidence is inside wall-clock and LLM call caps.
- Dry-run cherry-pick in a lab succeeds.
- PR body includes Korean summary, predicate evidence, changed files, and target metric.

Default denylist:

- `bots/investment/**`
- `bots/reservation/**`
- `bots/hub/**`
- `scripts/deploy*`
- `**/launchd/**`
- `*.plist`

Adopt means "PR opened", not "merged into main".
