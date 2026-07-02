# LLM OAuth4 Master Review

- generated_at: 2026-07-02T15:51:55.652Z
- hours: 168
- stats_source: db_fallback
- total_calls: 45208
- oauth_share_pct: 92.29
- failed_rate_pct: 0.03
- reported_cost_usd: 15.03055
- oauth_reported_cost_usd: 13.508346
- claude_code_reported_cost_usd: 13.508346
- claude_code_runtime_cost_share_pct: 89.87
- non_oauth_reported_cost_usd: 1.522204
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 3.26
- selector_claude_code_sonnet_primary_share_pct: 2.17

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 54 | 0.12 | 100.00 | 130615 | 13.508346 |
| OpenAI OAuth | 41667 | 92.17 | 100.00 | 3790 | 0.000000 |
| Gemini CLI OAuth | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 3418 | 7.56 | 100.00 | 654 | 1.522204 |
| Failed | 12 | 0.03 | 0.00 | 0 | 0.000000 |

## Selector Matrix

- selector_version: v3.0_oauth_4
- checked_selector_keys: 91
- checked_agent_routes: 93
- selector_primary_provider_counts: {"openai-oauth":89,"claude-code":6,"groq":84,"local-embedding":2,"gemini-cli-oauth":3}
- selector_primary_provider_shares: {"claude-code":3.26,"gemini-cli-oauth":1.63,"groq":45.65,"local-embedding":1.09,"openai-oauth":48.37}
- selector_primary_model_counts: {"openai-oauth/gpt-5.4-mini":34,"claude-code/haiku":2,"openai-oauth/gpt-5.4":51,"groq/llama-3.1-8b-instant":67,"claude-code/sonnet":4,"local-embedding/qwen3-embed-0.6b":2,"openai-oauth/gpt-5.5":4,"gemini-cli-oauth/gemini-2.5-pro":1,"gemini-cli-oauth/gemini-2.5-flash":2,"groq/qwen/qwen3-32b":15,"groq/openai/gpt-oss-20b":2}
- selector_primary_model_shares: {"claude-code/haiku":1.09,"claude-code/sonnet":2.17,"gemini-cli-oauth/gemini-2.5-flash":1.09,"gemini-cli-oauth/gemini-2.5-pro":0.54,"groq/llama-3.1-8b-instant":36.41,"groq/openai/gpt-oss-20b":1.09,"groq/qwen/qwen3-32b":8.15,"local-embedding/qwen3-embed-0.6b":1.09,"openai-oauth/gpt-5.4":27.72,"openai-oauth/gpt-5.4-mini":18.48,"openai-oauth/gpt-5.5":2.17}

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

- hub_http_stats_unavailable_used_db_fallback:fetch failed
- runtime_reported_cost_is_accounting_or_cli_imputed_cost_not_oauth4_billing_gate
- runtime_claude_code_reported_cost_share_high_reduce_sonnet_primary_routes
- non_oauth_runtime_cost_observed_groq_or_other_fallback_usage
