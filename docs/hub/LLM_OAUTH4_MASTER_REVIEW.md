# LLM OAuth4 Master Review

- generated_at: 2026-07-12T23:42:32.074Z
- hours: 168
- stats_source: db_fallback
- total_calls: 5769
- oauth_share_pct: 62.09
- failed_rate_pct: 0.64
- reported_cost_usd: 24.199277
- oauth_reported_cost_usd: 24.019639
- claude_code_reported_cost_usd: 24.019639
- claude_code_runtime_cost_share_pct: 99.26
- non_oauth_reported_cost_usd: 0.179638
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 4.49
- selector_claude_code_sonnet_primary_share_pct: 2.25

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 101 | 1.75 | 100.00 | 87845 | 24.019639 |
| OpenAI OAuth | 3481 | 60.34 | 100.00 | 4677 | 0.000000 |
| Gemini CLI OAuth | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 791 | 13.71 | 100.00 | 632 | 0.179638 |
| Failed | 37 | 0.64 | 0.00 | 0 | 0.000000 |
| local-embedding | 1350 | 23.40 | 100.00 | 895 | 0.000000 |
| dedupe | 9 | 0.16 | 100.00 | 24764 | 0.000000 |

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

- hub_http_stats_unavailable_used_db_fallback:fetch failed
- runtime_reported_cost_is_accounting_or_cli_imputed_cost_not_oauth4_billing_gate
- runtime_claude_code_reported_cost_share_high_reduce_sonnet_primary_routes
- non_oauth_runtime_cost_observed_groq_or_other_fallback_usage
