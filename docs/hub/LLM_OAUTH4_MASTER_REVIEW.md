# LLM OAuth4 Master Review

- generated_at: 2026-05-05T23:55:19.123Z
- hours: 168
- total_calls: 31112
- oauth_share_pct: 38.16
- failed_rate_pct: 0.44
- reported_cost_usd: 92.225528
- oauth_reported_cost_usd: 90.6082
- claude_code_reported_cost_usd: 90.6082
- claude_code_runtime_cost_share_pct: 98.25
- non_oauth_reported_cost_usd: 1.617328
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 20.3
- selector_claude_code_sonnet_primary_share_pct: 2.54

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 1663 | 5.35 | 100.00 | 17976 | 90.608200 |
| OpenAI OAuth | 9142 | 29.38 | 100.00 | 3644 | 0.000000 |
| Gemini CLI OAuth | 1067 | 3.43 | 100.00 | 14294 | 0.000000 |
| Gemini OAuth | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 19104 | 61.40 | 100.00 | 744 | 1.617328 |
| Failed | 136 | 0.44 | 0.00 | 3044 | 0.000000 |

## Selector Matrix

- selector_version: v3.0_oauth_4
- checked_selector_keys: 65
- checked_agent_routes: 132
- selector_primary_provider_counts: {"openai-oauth":103,"groq":23,"claude-code":40,"gemini-cli-oauth":31}
- selector_primary_provider_shares: {"claude-code":20.3,"gemini-cli-oauth":15.74,"groq":11.68,"openai-oauth":52.28}
- selector_primary_model_counts: {"openai-oauth/gpt-5.4":60,"groq/llama-3.1-8b-instant":15,"openai-oauth/gpt-5.4-mini":25,"claude-code/haiku":28,"gemini-cli-oauth/gemini-2.5-flash":20,"gemini-cli-oauth/gemini-2.5-flash-lite":11,"claude-code/sonnet":5,"groq/qwen/qwen3-32b":6,"openai-oauth/gpt-4o-mini":18,"groq/openai/gpt-oss-20b":2,"claude-code/opus":7}
- selector_primary_model_shares: {"claude-code/haiku":14.21,"claude-code/opus":3.55,"claude-code/sonnet":2.54,"gemini-cli-oauth/gemini-2.5-flash":10.15,"gemini-cli-oauth/gemini-2.5-flash-lite":5.58,"groq/llama-3.1-8b-instant":7.61,"groq/openai/gpt-oss-20b":1.02,"groq/qwen/qwen3-32b":3.05,"openai-oauth/gpt-4o-mini":9.14,"openai-oauth/gpt-5.4":30.46,"openai-oauth/gpt-5.4-mini":12.69}

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
- runtime_claude_code_reported_cost_share_high_reduce_sonnet_primary_routes
- non_oauth_runtime_cost_observed_groq_or_other_fallback_usage
