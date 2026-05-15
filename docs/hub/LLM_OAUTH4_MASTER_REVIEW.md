# LLM OAuth4 Master Review

- generated_at: 2026-05-15T04:32:52.076Z
- hours: 168
- stats_source: hub_http
- total_calls: 5187
- oauth_share_pct: 33.18
- failed_rate_pct: 0.23
- reported_cost_usd: 1.458957
- oauth_reported_cost_usd: 0
- claude_code_reported_cost_usd: 0
- claude_code_runtime_cost_share_pct: 0
- non_oauth_reported_cost_usd: 1.458957
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 0
- selector_claude_code_sonnet_primary_share_pct: 0

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| OpenAI OAuth | 1196 | 23.06 | 100.00 | 5777 | 0.000000 |
| Gemini CLI OAuth | 525 | 10.12 | 100.00 | 21098 | 0.000000 |
| Gemini OAuth | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 3448 | 66.47 | 100.00 | 1372 | 1.458957 |
| Failed | 12 | 0.23 | 0.00 | 61990 | 0.000000 |

## Selector Matrix

- selector_version: v3.0_oauth_4
- checked_selector_keys: 78
- checked_agent_routes: 84
- selector_primary_provider_counts: {"gemini-cli-oauth":85,"openai-oauth":33,"groq":44}
- selector_primary_provider_shares: {"gemini-cli-oauth":52.47,"groq":27.16,"openai-oauth":20.37}
- selector_primary_model_counts: {"gemini-cli-oauth/gemini-2.5-flash":55,"openai-oauth/gpt-5.4":24,"groq/llama-3.1-8b-instant":24,"gemini-cli-oauth/gemini-2.5-flash-lite":29,"openai-oauth/gpt-5.4-mini":9,"gemini-cli-oauth/gemini-2.5-pro":1,"groq/qwen/qwen3-32b":18,"groq/openai/gpt-oss-20b":2}
- selector_primary_model_shares: {"gemini-cli-oauth/gemini-2.5-flash":33.95,"gemini-cli-oauth/gemini-2.5-flash-lite":17.9,"gemini-cli-oauth/gemini-2.5-pro":0.62,"groq/llama-3.1-8b-instant":14.81,"groq/openai/gpt-oss-20b":1.23,"groq/qwen/qwen3-32b":11.11,"openai-oauth/gpt-5.4":14.81,"openai-oauth/gpt-5.4-mini":5.56}

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
