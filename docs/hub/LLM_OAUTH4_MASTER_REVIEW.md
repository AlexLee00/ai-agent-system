# LLM OAuth4 Master Review

- generated_at: 2026-05-22T04:32:59.463Z
- hours: 168
- stats_source: hub_http
- total_calls: 98918
- oauth_share_pct: 91.62
- failed_rate_pct: 0.02
- reported_cost_usd: 2.404703
- oauth_reported_cost_usd: 0
- claude_code_reported_cost_usd: 0
- claude_code_runtime_cost_share_pct: 0
- non_oauth_reported_cost_usd: 2.404703
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 0
- selector_claude_code_sonnet_primary_share_pct: 0

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| OpenAI OAuth | 89404 | 90.38 | 100.00 | 2072 | 0.000000 |
| Gemini CLI OAuth | 1224 | 1.24 | 100.00 | 13903 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 5757 | 5.82 | 100.00 | 1453 | 2.404703 |
| Failed | 16 | 0.02 | 0.00 | 6669 | 0.000000 |

## Selector Matrix

- selector_version: v3.0_oauth_4
- checked_selector_keys: 81
- checked_agent_routes: 89
- selector_primary_provider_counts: {"gemini-cli-oauth":92,"openai-oauth":34,"groq":44}
- selector_primary_provider_shares: {"gemini-cli-oauth":54.12,"groq":25.88,"openai-oauth":20}
- selector_primary_model_counts: {"gemini-cli-oauth/gemini-2.5-flash":61,"openai-oauth/gpt-5.4":26,"groq/llama-3.1-8b-instant":24,"gemini-cli-oauth/gemini-2.5-flash-lite":30,"openai-oauth/gpt-5.4-mini":8,"gemini-cli-oauth/gemini-2.5-pro":1,"groq/qwen/qwen3-32b":18,"groq/openai/gpt-oss-20b":2}
- selector_primary_model_shares: {"gemini-cli-oauth/gemini-2.5-flash":35.88,"gemini-cli-oauth/gemini-2.5-flash-lite":17.65,"gemini-cli-oauth/gemini-2.5-pro":0.59,"groq/llama-3.1-8b-instant":14.12,"groq/openai/gpt-oss-20b":1.18,"groq/qwen/qwen3-32b":10.59,"openai-oauth/gpt-5.4":15.29,"openai-oauth/gpt-5.4-mini":4.71}

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
- non_oauth_runtime_cost_observed_groq_or_other_fallback_usage
