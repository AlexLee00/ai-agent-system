# LLM OAuth4 Master Review

- generated_at: 2026-05-07T11:55:32.367Z
- hours: 168
- total_calls: 30169
- oauth_share_pct: 44.16
- failed_rate_pct: 0.02
- reported_cost_usd: 126.669641
- oauth_reported_cost_usd: 124.602337
- claude_code_reported_cost_usd: 124.602337
- claude_code_runtime_cost_share_pct: 98.37
- non_oauth_reported_cost_usd: 2.067304
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 0
- selector_claude_code_sonnet_primary_share_pct: 0

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 1991 | 6.60 | 100.00 | 19336 | 124.602337 |
| OpenAI OAuth | 9133 | 30.27 | 100.00 | 3653 | 0.000000 |
| Gemini CLI OAuth | 2198 | 7.29 | 100.00 | 14151 | 0.000000 |
| Gemini OAuth | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 16840 | 55.82 | 100.00 | 782 | 2.067304 |
| Failed | 7 | 0.02 | 0.00 | 23958 | 0.000000 |

## Selector Matrix

- selector_version: v3.0_oauth_4
- checked_selector_keys: 65
- checked_agent_routes: 132
- selector_primary_provider_counts: {"openai-oauth":143,"groq":23,"gemini-cli-oauth":31}
- selector_primary_provider_shares: {"gemini-cli-oauth":15.74,"groq":11.68,"openai-oauth":72.59}
- selector_primary_model_counts: {"openai-oauth/gpt-5.4":72,"groq/llama-3.1-8b-instant":15,"openai-oauth/gpt-5.4-mini":50,"gemini-cli-oauth/gemini-2.5-flash":20,"gemini-cli-oauth/gemini-2.5-flash-lite":11,"groq/qwen/qwen3-32b":6,"openai-oauth/gpt-4o-mini":21,"groq/openai/gpt-oss-20b":2}
- selector_primary_model_shares: {"gemini-cli-oauth/gemini-2.5-flash":10.15,"gemini-cli-oauth/gemini-2.5-flash-lite":5.58,"groq/llama-3.1-8b-instant":7.61,"groq/openai/gpt-oss-20b":1.02,"groq/qwen/qwen3-32b":3.05,"openai-oauth/gpt-4o-mini":10.66,"openai-oauth/gpt-5.4":36.55,"openai-oauth/gpt-5.4-mini":25.38}

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
