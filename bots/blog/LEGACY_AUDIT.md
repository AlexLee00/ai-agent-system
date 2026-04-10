# Blog TS Audit

Updated: 2026-04-11

## Current state

- `bots/blog/**/*.js`: `0`
- `bots/blog/**/*.legacy.js`: `0`
- Runtime entrypoints and launchd now execute direct `.ts` files
- `dist/ts-runtime/bots/blog` runtime dependency has been removed

## Verification commands

1. `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/blog run typecheck`
2. `node /Users/alexlee/projects/ai-agent-system/bots/blog/scripts/run-daily.ts --verify --json`
3. `node /Users/alexlee/projects/ai-agent-system/bots/blog/scripts/check-instagram-readiness.ts --json`

## Remaining non-code work

- Set `instagram.access_token`
- Set `instagram.ig_user_id`
- Keep local launchd plists synced with `bots/blog/launchd`
