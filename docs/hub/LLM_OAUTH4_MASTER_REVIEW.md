# LLM OAuth4 Master Review

- generated_at: 2026-05-12T17:54:53.047Z
- hours: 168
- total_calls: 15080
- oauth_share_pct: 52.33
- failed_rate_pct: 0.56
- reported_cost_usd: 62.058215
- oauth_reported_cost_usd: 60.333425
- claude_code_reported_cost_usd: 60.333425
- claude_code_runtime_cost_share_pct: 97.22
- non_oauth_reported_cost_usd: 1.72479
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 0
- selector_claude_code_sonnet_primary_share_pct: 0

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 831 | 5.51 | 100.00 | 22353 | 60.333425 |
| OpenAI OAuth | 5277 | 34.99 | 100.00 | 3634 | 0.000000 |
| Gemini CLI OAuth | 1783 | 11.82 | 100.00 | 17255 | 0.000000 |
| Gemini OAuth | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 7087 | 47.00 | 100.00 | 976 | 1.724790 |
| Failed | 84 | 0.56 | 0.00 | 30995 | 0.000000 |

## Selector Matrix

- selector_version: v3.0_oauth_4
- checked_selector_keys: 78
- checked_agent_routes: 83
- selector_primary_provider_counts: {"gemini-cli-oauth":86,"openai-oauth":30,"groq":45}
- selector_primary_provider_shares: {"gemini-cli-oauth":53.42,"groq":27.95,"openai-oauth":18.63}
- selector_primary_model_counts: {"gemini-cli-oauth/gemini-2.5-flash":55,"openai-oauth/gpt-5.4":24,"groq/llama-3.1-8b-instant":24,"gemini-cli-oauth/gemini-2.5-flash-lite":30,"openai-oauth/gpt-5.4-mini":6,"gemini-cli-oauth/gemini-2.5-pro":1,"groq/qwen/qwen3-32b":19,"groq/openai/gpt-oss-20b":2}
- selector_primary_model_shares: {"gemini-cli-oauth/gemini-2.5-flash":34.16,"gemini-cli-oauth/gemini-2.5-flash-lite":18.63,"gemini-cli-oauth/gemini-2.5-pro":0.62,"groq/llama-3.1-8b-instant":14.91,"groq/openai/gpt-oss-20b":1.24,"groq/qwen/qwen3-32b":11.8,"openai-oauth/gpt-5.4":14.91,"openai-oauth/gpt-5.4-mini":3.73}

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
