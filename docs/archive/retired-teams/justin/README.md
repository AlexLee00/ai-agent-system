# Justin Team Retirement

- Team lifecycle retirement date: 2026-07-02
- Full runtime decommission date: 2026-07-21
- Scope: Team Jay internal Justin agents, Hub legal routes/selectors/runtime profiles, reseed paths, and the Justin Slack bot LaunchAgent
- External source: `/Users/alexlee/projects/justin-court-appraisal` preserved without modification

## Preserved Evidence

- `legal` PostgreSQL schema and historical rows
- LLM routing logs, Sigma memories, contracts, and audit history
- Hub `secrets-store` and all key material
- Retired Telegram topic cleanup compatibility

## Runtime State

- Justin agents and skills are archived, not deleted, in PostgreSQL.
- New Justin LLM routes are classified as `retired_llm_target`.
- Team routing falls back to Jay for legal or retired-team requests.
- The Slack bot plist is retained in a restricted operational backup for rollback.

## Rollback

Rollback requires a separate master decision: restore the archived LaunchAgent plist, restore source registrations from Git history, change archived DB rows back to the approved state, and run the retirement contract and team SSOT audits again.
