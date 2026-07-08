# LLM OAuth4 Master Review

- generated_at: 2026-07-08T15:52:03.197Z
- hours: 168
- stats_source: hub_http
- total_calls: 6958
- oauth_share_pct: 79.48
- failed_rate_pct: 0.96
- reported_cost_usd: 10.466524
- oauth_reported_cost_usd: 10.220162
- claude_code_reported_cost_usd: 10.220162
- claude_code_runtime_cost_share_pct: 97.65
- non_oauth_reported_cost_usd: 0.246362
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 4.49
- selector_claude_code_sonnet_primary_share_pct: 2.25

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 49 | 0.70 | 100.00 | 85352 | 10.220162 |
| OpenAI OAuth | 5481 | 78.77 | 100.00 | 5038 | 0.000000 |
| Gemini CLI OAuth | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 992 | 14.26 | 100.00 | 772 | 0.246362 |
| Failed | 67 | 0.96 | 0.00 | 2851 | 0.000000 |

## Selector Matrix

- selector_version: v3.0_oauth_4
- checked_selector_keys: 89
- checked_agent_routes: 89
- selector_primary_provider_counts: {"openai-oauth":105,"claude-code":8,"groq":60,"local-embedding":2,"gemini-cli-oauth":3}
- selector_primary_provider_shares: {"claude-code":4.49,"gemini-cli-oauth":1.69,"groq":33.71,"local-embedding":1.12,"openai-oauth":58.99}
- selector_primary_model_counts: {"openai-oauth/gpt-5.4-mini":44,"claude-code/haiku":4,"openai-oauth/gpt-5.4":57,"groq/llama-3.1-8b-instant":45,"claude-code/sonnet":4,"local-embedding/qwen3-embed-0.6b":2,"openai-oauth/gpt-5.5":4,"gemini-cli-oauth/gemini-2.5-pro":1,"gemini-cli-oauth/gemini-2.5-flash":2,"groq/qwen/qwen3-32b":9,"groq/llama-3.3-70b-versatile":4,"groq/openai/gpt-oss-20b":2}
- selector_primary_model_shares: {"claude-code/haiku":2.25,"claude-code/sonnet":2.25,"gemini-cli-oauth/gemini-2.5-flash":1.12,"gemini-cli-oauth/gemini-2.5-pro":0.56,"groq/llama-3.1-8b-instant":25.28,"groq/llama-3.3-70b-versatile":2.25,"groq/openai/gpt-oss-20b":1.12,"groq/qwen/qwen3-32b":5.06,"local-embedding/qwen3-embed-0.6b":1.12,"openai-oauth/gpt-5.4":32.02,"openai-oauth/gpt-5.4-mini":24.72,"openai-oauth/gpt-5.5":2.25}

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
