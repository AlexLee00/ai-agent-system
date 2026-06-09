# LLM OAuth4 Master Review

- generated_at: 2026-06-09T04:33:16.879Z
- hours: 168
- stats_source: hub_http
- total_calls: 54939
- oauth_share_pct: 92.88
- failed_rate_pct: 0.01
- reported_cost_usd: 16.19489
- oauth_reported_cost_usd: 13.415563
- claude_code_reported_cost_usd: 13.415563
- claude_code_runtime_cost_share_pct: 82.84
- non_oauth_reported_cost_usd: 2.779327
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 3.31
- selector_claude_code_sonnet_primary_share_pct: 2.21

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 79 | 0.14 | 100.00 | 112497 | 13.415563 |
| OpenAI OAuth | 50948 | 92.74 | 100.00 | 5031 | 0.000000 |
| Gemini CLI OAuth | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 3847 | 7.00 | 100.00 | 1947 | 2.779327 |
| Failed | 6 | 0.01 | 0.00 | 884 | 0.000000 |

## Selector Matrix

- selector_version: v3.0_oauth_4
- checked_selector_keys: 88
- checked_agent_routes: 93
- selector_primary_provider_counts: {"openai-oauth":90,"claude-code":6,"groq":76,"local-embedding":2,"local":4,"gemini-cli-oauth":3}
- selector_primary_provider_shares: {"claude-code":3.31,"gemini-cli-oauth":1.66,"groq":41.99,"local":2.21,"local-embedding":1.1,"openai-oauth":49.72}
- selector_primary_model_counts: {"openai-oauth/gpt-5.4-mini":28,"claude-code/haiku":2,"openai-oauth/gpt-5.4":58,"groq/llama-3.1-8b-instant":59,"claude-code/sonnet":4,"local-embedding/qwen3-embed-0.6b":2,"openai-oauth/gpt-5.5":4,"local/qwen2.5-7b":4,"gemini-cli-oauth/gemini-2.5-pro":1,"gemini-cli-oauth/gemini-2.5-flash":2,"groq/qwen/qwen3-32b":15,"groq/openai/gpt-oss-20b":2}
- selector_primary_model_shares: {"claude-code/haiku":1.1,"claude-code/sonnet":2.21,"gemini-cli-oauth/gemini-2.5-flash":1.1,"gemini-cli-oauth/gemini-2.5-pro":0.55,"groq/llama-3.1-8b-instant":32.6,"groq/openai/gpt-oss-20b":1.1,"groq/qwen/qwen3-32b":8.29,"local-embedding/qwen3-embed-0.6b":1.1,"local/qwen2.5-7b":2.21,"openai-oauth/gpt-5.4":32.04,"openai-oauth/gpt-5.4-mini":15.47,"openai-oauth/gpt-5.5":2.21}

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
