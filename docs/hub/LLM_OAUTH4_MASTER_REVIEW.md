# LLM OAuth4 Master Review

- generated_at: 2026-07-03T15:51:54.678Z
- hours: 168
- stats_source: hub_http
- total_calls: 45139
- oauth_share_pct: 93.55
- failed_rate_pct: 0.04
- reported_cost_usd: 14.036087
- oauth_reported_cost_usd: 12.888057
- claude_code_reported_cost_usd: 12.888057
- claude_code_runtime_cost_share_pct: 91.82
- non_oauth_reported_cost_usd: 1.14803
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 3.41
- selector_claude_code_sonnet_primary_share_pct: 2.27

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 53 | 0.12 | 100.00 | 126686 | 12.888057 |
| OpenAI OAuth | 42176 | 93.44 | 100.00 | 3801 | 0.000000 |
| Gemini CLI OAuth | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 2841 | 6.29 | 100.00 | 663 | 1.148030 |
| Failed | 18 | 0.04 | 0.00 | 0 | 0.000000 |

## Selector Matrix

- selector_version: v3.0_oauth_4
- checked_selector_keys: 87
- checked_agent_routes: 89
- selector_primary_provider_counts: {"openai-oauth":105,"claude-code":6,"groq":60,"local-embedding":2,"gemini-cli-oauth":3}
- selector_primary_provider_shares: {"claude-code":3.41,"gemini-cli-oauth":1.7,"groq":34.09,"local-embedding":1.14,"openai-oauth":59.66}
- selector_primary_model_counts: {"openai-oauth/gpt-5.4-mini":44,"claude-code/haiku":2,"openai-oauth/gpt-5.4":57,"groq/llama-3.1-8b-instant":45,"claude-code/sonnet":4,"local-embedding/qwen3-embed-0.6b":2,"openai-oauth/gpt-5.5":4,"gemini-cli-oauth/gemini-2.5-pro":1,"gemini-cli-oauth/gemini-2.5-flash":2,"groq/qwen/qwen3-32b":9,"groq/llama-3.3-70b-versatile":4,"groq/openai/gpt-oss-20b":2}
- selector_primary_model_shares: {"claude-code/haiku":1.14,"claude-code/sonnet":2.27,"gemini-cli-oauth/gemini-2.5-flash":1.14,"gemini-cli-oauth/gemini-2.5-pro":0.57,"groq/llama-3.1-8b-instant":25.57,"groq/llama-3.3-70b-versatile":2.27,"groq/openai/gpt-oss-20b":1.14,"groq/qwen/qwen3-32b":5.11,"local-embedding/qwen3-embed-0.6b":1.14,"openai-oauth/gpt-5.4":32.39,"openai-oauth/gpt-5.4-mini":25,"openai-oauth/gpt-5.5":2.27}

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
