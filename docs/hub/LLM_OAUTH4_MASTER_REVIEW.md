# LLM OAuth4 Master Review

- generated_at: 2026-06-10T04:35:48.994Z
- hours: 168
- stats_source: hub_http
- total_calls: 54398
- oauth_share_pct: 92.38
- failed_rate_pct: 0.03
- reported_cost_usd: 15.72026
- oauth_reported_cost_usd: 13.198955
- claude_code_reported_cost_usd: 13.198955
- claude_code_runtime_cost_share_pct: 83.96
- non_oauth_reported_cost_usd: 2.521305
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 3.3
- selector_claude_code_sonnet_primary_share_pct: 2.2

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 76 | 0.14 | 100.00 | 115442 | 13.198955 |
| OpenAI OAuth | 50176 | 92.24 | 100.00 | 5045 | 0.000000 |
| Gemini CLI OAuth | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 4014 | 7.38 | 100.00 | 1737 | 2.521305 |
| Failed | 16 | 0.03 | 0.00 | 45528 | 0.000000 |

## Selector Matrix

- selector_version: v3.0_oauth_4
- checked_selector_keys: 89
- checked_agent_routes: 93
- selector_primary_provider_counts: {"openai-oauth":90,"claude-code":6,"groq":77,"local-embedding":2,"local":4,"gemini-cli-oauth":3}
- selector_primary_provider_shares: {"claude-code":3.3,"gemini-cli-oauth":1.65,"groq":42.31,"local":2.2,"local-embedding":1.1,"openai-oauth":49.45}
- selector_primary_model_counts: {"openai-oauth/gpt-5.4-mini":28,"claude-code/haiku":2,"openai-oauth/gpt-5.4":58,"groq/llama-3.1-8b-instant":60,"claude-code/sonnet":4,"local-embedding/qwen3-embed-0.6b":2,"openai-oauth/gpt-5.5":4,"local/qwen2.5-7b":4,"gemini-cli-oauth/gemini-2.5-pro":1,"gemini-cli-oauth/gemini-2.5-flash":2,"groq/qwen/qwen3-32b":15,"groq/openai/gpt-oss-20b":2}
- selector_primary_model_shares: {"claude-code/haiku":1.1,"claude-code/sonnet":2.2,"gemini-cli-oauth/gemini-2.5-flash":1.1,"gemini-cli-oauth/gemini-2.5-pro":0.55,"groq/llama-3.1-8b-instant":32.97,"groq/openai/gpt-oss-20b":1.1,"groq/qwen/qwen3-32b":8.24,"local-embedding/qwen3-embed-0.6b":1.1,"local/qwen2.5-7b":2.2,"openai-oauth/gpt-5.4":31.87,"openai-oauth/gpt-5.4-mini":15.38,"openai-oauth/gpt-5.5":2.2}

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
