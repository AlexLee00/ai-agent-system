# LLM OAuth4 Master Review

- generated_at: 2026-06-28T11:06:00.641Z
- hours: 168
- stats_source: hub_http
- total_calls: 53126
- oauth_share_pct: 92.24
- failed_rate_pct: 0.01
- reported_cost_usd: 9.043022
- oauth_reported_cost_usd: 7.418895
- claude_code_reported_cost_usd: 7.418895
- claude_code_runtime_cost_share_pct: 82.04
- non_oauth_reported_cost_usd: 1.624127
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 3.3
- selector_claude_code_sonnet_primary_share_pct: 2.2

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 32 | 0.06 | 100.00 | 113724 | 7.418895 |
| OpenAI OAuth | 48971 | 92.18 | 100.00 | 3330 | 0.000000 |
| Gemini CLI OAuth | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 3521 | 6.63 | 100.00 | 621 | 1.624127 |
| Failed | 7 | 0.01 | 0.00 | 6287 | 0.000000 |

## Selector Matrix

- selector_version: v3.0_oauth_4
- checked_selector_keys: 89
- checked_agent_routes: 93
- selector_primary_provider_counts: {"openai-oauth":89,"claude-code":6,"groq":82,"local-embedding":2,"gemini-cli-oauth":3}
- selector_primary_provider_shares: {"claude-code":3.3,"gemini-cli-oauth":1.65,"groq":45.05,"local-embedding":1.1,"openai-oauth":48.9}
- selector_primary_model_counts: {"openai-oauth/gpt-5.4-mini":34,"claude-code/haiku":2,"openai-oauth/gpt-5.4":51,"groq/llama-3.1-8b-instant":65,"claude-code/sonnet":4,"local-embedding/qwen3-embed-0.6b":2,"openai-oauth/gpt-5.5":4,"gemini-cli-oauth/gemini-2.5-pro":1,"gemini-cli-oauth/gemini-2.5-flash":2,"groq/qwen/qwen3-32b":15,"groq/openai/gpt-oss-20b":2}
- selector_primary_model_shares: {"claude-code/haiku":1.1,"claude-code/sonnet":2.2,"gemini-cli-oauth/gemini-2.5-flash":1.1,"gemini-cli-oauth/gemini-2.5-pro":0.55,"groq/llama-3.1-8b-instant":35.71,"groq/openai/gpt-oss-20b":1.1,"groq/qwen/qwen3-32b":8.24,"local-embedding/qwen3-embed-0.6b":1.1,"openai-oauth/gpt-5.4":28.02,"openai-oauth/gpt-5.4-mini":18.68,"openai-oauth/gpt-5.5":2.2}

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
