# Hub Model Selection Guide

## Principles

- Hub owns LLM routing through selector keys and runtime profiles.
- Callers should pass intent fields (`callerTeam`, `agent`, `selectorKey`, `taskType`) instead of provider routes.
- `hub._default` is the safe terminal fallback for eligible LLM calls when no team profile matches.
- Non-LLM targets and explicit target-policy blocks stay blocked; default fallback is not a bypass.

## Model Fit Matrix

| Workload | Default class | Notes |
| --- | --- | --- |
| Bulk, summaries, low-risk drafting | Haiku / mini / fast | Prefer cheapest chain that passes quality smoke. |
| Long-form writing or synthesis | Sonnet candidate | Use team-specific gates such as `BLOG_WRITER_MODEL` before rollout. |
| High-stakes judgment | Opus or code reasoning candidate | Keep behind explicit selector and budget guard. |
| Code execution / tool-heavy analysis | Code-capable route | Do not silently substitute local text models. |
| Embeddings and vector search | Local MLX / local embedding | Must remain non-chat and schema-specific. |

## Fallback And Circuit Standard

- `HUB_RESILIENCE_ENABLED=false` preserves current provider order and circuit behavior.
- When enabled, provider circuit policy is 5 failures and 60 seconds cooldown.
- Fallback order is selector-bounded: same provider cheaper route, other provider route, then local terminal only if the selector already includes local.
- `fallback_used`, `fallback_count`, `routing_source`, and `latency_ms` are written only after standard log columns exist.

## Auto-Routing

- `LLM_AUTO_ROUTING_ENABLED=shadow` records policy comparison only.
- Shadow mode must not mutate `abstractModel`, selector chain, provider, or timeout.
- Active mode remains a separate master-gated promotion decision.

## Flow

1. Resolve explicit selector key.
2. Resolve agent registry mapping.
3. Resolve runtime profile by team and purpose.
4. Fall back to `hub._default` for eligible LLM calls.
5. Apply token budget, provider circuit, fallback, and logging.

## FAQ

- **Why did a call use `hub._default`?** The team/purpose had no matching selector-backed profile.
- **Can callers pass ad-hoc chains?** No, unless `HUB_LLM_ALLOW_ADHOC_CHAIN=true`.
- **Does local fallback apply everywhere?** No. It is only used when the selector chain already includes local.
- **Can migration be skipped?** Yes. New log fields are skipped until the columns exist.
