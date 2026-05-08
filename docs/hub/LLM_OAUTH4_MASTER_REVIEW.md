# LLM OAuth4 Master Review

- generated_at: 2026-05-08T18:55:45.931Z
- hours: 168
- total_calls: 26943
- oauth_share_pct: 50.32
- failed_rate_pct: 0.31
- reported_cost_usd: 126.091623
- oauth_reported_cost_usd: 124.240522
- claude_code_reported_cost_usd: 124.240522
- claude_code_runtime_cost_share_pct: 98.53
- non_oauth_reported_cost_usd: 1.851101
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 0
- selector_claude_code_sonnet_primary_share_pct: 0

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 1979 | 7.35 | 100.00 | 19332 | 124.240522 |
| OpenAI OAuth | 9317 | 34.58 | 100.00 | 3597 | 0.000000 |
| Gemini CLI OAuth | 2263 | 8.40 | 100.00 | 14530 | 0.000000 |
| Gemini OAuth | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 13289 | 49.32 | 100.00 | 820 | 1.851101 |
| Failed | 83 | 0.31 | 0.00 | 30645 | 0.000000 |

## Selector Matrix

- selector_version: v3.0_oauth_4
- checked_selector_keys: 72
- checked_agent_routes: 59
- selector_primary_provider_counts: {"gemini-cli-oauth":63,"groq":43,"openai-oauth":25}
- selector_primary_provider_shares: {"gemini-cli-oauth":48.09,"groq":32.82,"openai-oauth":19.08}
- selector_primary_model_counts: {"gemini-cli-oauth/gemini-2.5-flash":35,"groq/llama-3.1-8b-instant":22,"gemini-cli-oauth/gemini-2.5-flash-lite":27,"openai-oauth/gpt-5.4":19,"openai-oauth/gpt-5.4-mini":6,"gemini-cli-oauth/gemini-2.5-pro":1,"groq/qwen/qwen3-32b":19,"groq/openai/gpt-oss-20b":2}
- selector_primary_model_shares: {"gemini-cli-oauth/gemini-2.5-flash":26.72,"gemini-cli-oauth/gemini-2.5-flash-lite":20.61,"gemini-cli-oauth/gemini-2.5-pro":0.76,"groq/llama-3.1-8b-instant":16.79,"groq/openai/gpt-oss-20b":1.53,"groq/qwen/qwen3-32b":14.5,"openai-oauth/gpt-5.4":14.5,"openai-oauth/gpt-5.4-mini":4.58}

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
- runtime_claude_code_reported_cost_share_high_historical_usage_wait_for_decay
- non_oauth_runtime_cost_observed_groq_or_other_fallback_usage
