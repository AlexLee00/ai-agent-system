# LLM OAuth4 Master Review

- generated_at: 2026-07-11T15:52:01.952Z
- hours: 168
- stats_source: hub_http
- total_calls: 4431
- oauth_share_pct: 82.19
- failed_rate_pct: 1.13
- reported_cost_usd: 18.287945
- oauth_reported_cost_usd: 18.118203
- claude_code_reported_cost_usd: 18.118203
- claude_code_runtime_cost_share_pct: 99.07
- non_oauth_reported_cost_usd: 0.169742
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 4.49
- selector_claude_code_sonnet_primary_share_pct: 2.25

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 85 | 1.92 | 100.00 | 80470 | 18.118203 |
| OpenAI OAuth | 3557 | 80.28 | 100.00 | 5124 | 0.000000 |
| Gemini CLI OAuth | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 725 | 16.36 | 100.00 | 649 | 0.169742 |
| Failed | 50 | 1.13 | 0.00 | 0 | 0.000000 |

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
- runtime_failed_rate_ok: false
- runtime_oauth_seen_ok: true
- reported_cost_accounting_only: true

## Warnings

- runtime_reported_cost_is_accounting_or_cli_imputed_cost_not_oauth4_billing_gate
- runtime_claude_code_reported_cost_share_high_reduce_sonnet_primary_routes
- non_oauth_runtime_cost_observed_groq_or_other_fallback_usage
