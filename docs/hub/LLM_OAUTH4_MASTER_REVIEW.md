# LLM OAuth4 Master Review

- generated_at: 2026-05-08T05:55:40.934Z
- hours: 168
- total_calls: 29379
- oauth_share_pct: 48.32
- failed_rate_pct: 0.28
- reported_cost_usd: 126.352098
- oauth_reported_cost_usd: 124.30812
- claude_code_reported_cost_usd: 124.30812
- claude_code_runtime_cost_share_pct: 98.38
- non_oauth_reported_cost_usd: 2.043978
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 0
- selector_claude_code_sonnet_primary_share_pct: 0

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 1980 | 6.74 | 100.00 | 19338 | 124.308120 |
| OpenAI OAuth | 9953 | 33.88 | 100.00 | 3522 | 0.000000 |
| Gemini CLI OAuth | 2263 | 7.70 | 100.00 | 14530 | 0.000000 |
| Gemini OAuth | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 15088 | 51.36 | 100.00 | 803 | 2.043978 |
| Failed | 83 | 0.28 | 0.00 | 30645 | 0.000000 |

## Selector Matrix

- selector_version: v3.0_oauth_4
- checked_selector_keys: 65
- checked_agent_routes: 59
- selector_primary_provider_counts: {"openai-oauth":87,"groq":14,"gemini-cli-oauth":23}
- selector_primary_provider_shares: {"gemini-cli-oauth":18.55,"groq":11.29,"openai-oauth":70.16}
- selector_primary_model_counts: {"openai-oauth/gpt-5.4":49,"groq/llama-3.1-8b-instant":8,"openai-oauth/gpt-5.4-mini":24,"gemini-cli-oauth/gemini-2.5-flash":14,"gemini-cli-oauth/gemini-2.5-flash-lite":9,"groq/qwen/qwen3-32b":4,"openai-oauth/gpt-4o-mini":14,"groq/openai/gpt-oss-20b":2}
- selector_primary_model_shares: {"gemini-cli-oauth/gemini-2.5-flash":11.29,"gemini-cli-oauth/gemini-2.5-flash-lite":7.26,"groq/llama-3.1-8b-instant":6.45,"groq/openai/gpt-oss-20b":1.61,"groq/qwen/qwen3-32b":3.23,"openai-oauth/gpt-4o-mini":11.29,"openai-oauth/gpt-5.4":39.52,"openai-oauth/gpt-5.4-mini":19.35}

## Verdict

- selector_claude_code_share_ok: true
- selector_claude_code_sonnet_share_ok: true
- selector_anthropic_primary_zero_ok: true
- selector_anthropic_chain_zero_ok: true
- runtime_anthropic_zero_ok: true
- runtime_failed_rate_ok: true
- runtime_oauth_seen_ok: true
- reported_cost_accounting_only: true

## Warnings

- runtime_reported_cost_is_accounting_or_cli_imputed_cost_not_oauth4_billing_gate
- runtime_claude_code_reported_cost_share_high_historical_usage_wait_for_decay
- non_oauth_runtime_cost_observed_groq_or_other_fallback_usage
