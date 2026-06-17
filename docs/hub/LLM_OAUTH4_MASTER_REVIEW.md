# LLM OAuth4 Master Review

- generated_at: 2026-06-17T11:05:45.860Z
- hours: 168
- stats_source: hub_http
- total_calls: 60320
- oauth_share_pct: 70.56
- failed_rate_pct: 0.4
- reported_cost_usd: 12.423404
- oauth_reported_cost_usd: 9.282713
- claude_code_reported_cost_usd: 9.282713
- claude_code_runtime_cost_share_pct: 74.72
- non_oauth_reported_cost_usd: 3.140691
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 3.3
- selector_claude_code_sonnet_primary_share_pct: 2.2

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 50 | 0.08 | 100.00 | 91856 | 9.282713 |
| OpenAI OAuth | 42511 | 70.48 | 100.00 | 4723 | 0.000000 |
| Gemini CLI OAuth | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 14001 | 23.21 | 100.00 | 626 | 3.140691 |
| Failed | 241 | 0.40 | 0.00 | 144044 | 0.000000 |

## Selector Matrix

- selector_version: v3.0_oauth_4
- checked_selector_keys: 89
- checked_agent_routes: 93
- selector_primary_provider_counts: {"openai-oauth":90,"claude-code":6,"groq":81,"local-embedding":2,"gemini-cli-oauth":3}
- selector_primary_provider_shares: {"claude-code":3.3,"gemini-cli-oauth":1.65,"groq":44.51,"local-embedding":1.1,"openai-oauth":49.45}
- selector_primary_model_counts: {"openai-oauth/gpt-5.4-mini":34,"claude-code/haiku":2,"openai-oauth/gpt-5.4":52,"groq/llama-3.1-8b-instant":64,"claude-code/sonnet":4,"local-embedding/qwen3-embed-0.6b":2,"openai-oauth/gpt-5.5":4,"gemini-cli-oauth/gemini-2.5-pro":1,"gemini-cli-oauth/gemini-2.5-flash":2,"groq/qwen/qwen3-32b":15,"groq/openai/gpt-oss-20b":2}
- selector_primary_model_shares: {"claude-code/haiku":1.1,"claude-code/sonnet":2.2,"gemini-cli-oauth/gemini-2.5-flash":1.1,"gemini-cli-oauth/gemini-2.5-pro":0.55,"groq/llama-3.1-8b-instant":35.16,"groq/openai/gpt-oss-20b":1.1,"groq/qwen/qwen3-32b":8.24,"local-embedding/qwen3-embed-0.6b":1.1,"openai-oauth/gpt-5.4":28.57,"openai-oauth/gpt-5.4-mini":18.68,"openai-oauth/gpt-5.5":2.2}

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
