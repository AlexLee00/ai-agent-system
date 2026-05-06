# LLM OAuth4 Master Review

- generated_at: 2026-05-06T05:55:23.297Z
- hours: 168
- total_calls: 30857
- oauth_share_pct: 39.41
- failed_rate_pct: 0.43
- reported_cost_usd: 102.741606
- oauth_reported_cost_usd: 101.165887
- claude_code_reported_cost_usd: 101.165887
- claude_code_runtime_cost_share_pct: 98.47
- non_oauth_reported_cost_usd: 1.575719
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 20.3
- selector_claude_code_sonnet_primary_share_pct: 2.54

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 1797 | 5.82 | 100.00 | 18085 | 101.165887 |
| OpenAI OAuth | 8952 | 29.01 | 100.00 | 3640 | 0.000000 |
| Gemini CLI OAuth | 1411 | 4.57 | 100.00 | 14568 | 0.000000 |
| Gemini OAuth | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 18563 | 60.16 | 100.00 | 752 | 1.575719 |
| Failed | 134 | 0.43 | 0.00 | 3089 | 0.000000 |

## Selector Matrix

- selector_version: v3.0_oauth_4
- checked_selector_keys: 65
- checked_agent_routes: 132
- selector_primary_provider_counts: {"openai-oauth":103,"groq":23,"claude-code":40,"gemini-cli-oauth":31}
- selector_primary_provider_shares: {"claude-code":20.3,"gemini-cli-oauth":15.74,"groq":11.68,"openai-oauth":52.28}
- selector_primary_model_counts: {"openai-oauth/gpt-5.4":60,"groq/llama-3.1-8b-instant":15,"openai-oauth/gpt-5.4-mini":25,"claude-code/haiku":28,"gemini-cli-oauth/gemini-2.5-flash":20,"gemini-cli-oauth/gemini-2.5-flash-lite":11,"claude-code/sonnet":5,"groq/qwen/qwen3-32b":6,"openai-oauth/gpt-4o-mini":18,"groq/openai/gpt-oss-20b":2,"claude-code/opus":7}
- selector_primary_model_shares: {"claude-code/haiku":14.21,"claude-code/opus":3.55,"claude-code/sonnet":2.54,"gemini-cli-oauth/gemini-2.5-flash":10.15,"gemini-cli-oauth/gemini-2.5-flash-lite":5.58,"groq/llama-3.1-8b-instant":7.61,"groq/openai/gpt-oss-20b":1.02,"groq/qwen/qwen3-32b":3.05,"openai-oauth/gpt-4o-mini":9.14,"openai-oauth/gpt-5.4":30.46,"openai-oauth/gpt-5.4-mini":12.69}

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
