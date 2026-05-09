# LLM OAuth4 Master Review

- generated_at: 2026-05-09T11:55:52.468Z
- hours: 168
- total_calls: 23287
- oauth_share_pct: 53.6
- failed_rate_pct: 0.36
- reported_cost_usd: 124.322648
- oauth_reported_cost_usd: 122.724262
- claude_code_reported_cost_usd: 122.724262
- claude_code_runtime_cost_share_pct: 98.71
- non_oauth_reported_cost_usd: 1.598386
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 0
- selector_claude_code_sonnet_primary_share_pct: 0

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 1951 | 8.38 | 100.00 | 19474 | 122.724262 |
| OpenAI OAuth | 8255 | 35.45 | 100.00 | 3739 | 0.000000 |
| Gemini CLI OAuth | 2276 | 9.77 | 100.00 | 14537 | 0.000000 |
| Gemini OAuth | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 10709 | 45.99 | 100.00 | 842 | 1.598386 |
| Failed | 84 | 0.36 | 0.00 | 30995 | 0.000000 |

## Selector Matrix

- selector_version: v3.0_oauth_4
- checked_selector_keys: 78
- checked_agent_routes: 83
- selector_primary_provider_counts: {"gemini-cli-oauth":90,"groq":43,"openai-oauth":28}
- selector_primary_provider_shares: {"gemini-cli-oauth":55.9,"groq":26.71,"openai-oauth":17.39}
- selector_primary_model_counts: {"gemini-cli-oauth/gemini-2.5-flash":55,"groq/llama-3.1-8b-instant":22,"gemini-cli-oauth/gemini-2.5-flash-lite":34,"openai-oauth/gpt-5.4":22,"openai-oauth/gpt-5.4-mini":6,"gemini-cli-oauth/gemini-2.5-pro":1,"groq/qwen/qwen3-32b":19,"groq/openai/gpt-oss-20b":2}
- selector_primary_model_shares: {"gemini-cli-oauth/gemini-2.5-flash":34.16,"gemini-cli-oauth/gemini-2.5-flash-lite":21.12,"gemini-cli-oauth/gemini-2.5-pro":0.62,"groq/llama-3.1-8b-instant":13.66,"groq/openai/gpt-oss-20b":1.24,"groq/qwen/qwen3-32b":11.8,"openai-oauth/gpt-5.4":13.66,"openai-oauth/gpt-5.4-mini":3.73}

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
