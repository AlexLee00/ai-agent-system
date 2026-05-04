# LLM OAuth4 Master Review

- generated_at: 2026-05-04T04:55:05.672Z
- hours: 168
- total_calls: 35389
- oauth_share_pct: 35.09
- failed_rate_pct: 0.16
- reported_cost_usd: 84.823433
- oauth_reported_cost_usd: 83.043395
- non_oauth_reported_cost_usd: 1.780038
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 49.48

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 851 | 2.40 | 100.00 | 21448 | 60.849103 |
| OpenAI OAuth | 7884 | 22.28 | 100.00 | 3154 | 0.000000 |
| Gemini CLI OAuth | 519 | 1.47 | 100.00 | 14729 | 0.000000 |
| Gemini OAuth | 31 | 0.09 | 100.00 | 1267 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 22538 | 63.69 | 100.00 | 724 | 1.770502 |
| Failed | 55 | 0.16 | 0.00 | 3322 | 0.000000 |

## Selector Matrix

- selector_version: v3.0_oauth_4
- checked_selector_keys: 64
- checked_agent_routes: 130
- selector_primary_provider_counts: {"openai-oauth":54,"claude-code":96,"groq":17,"gemini-cli-oauth":27}
- selector_primary_provider_shares: {"claude-code":49.48,"gemini-cli-oauth":13.92,"groq":8.76,"openai-oauth":27.84}

## Verdict

- selector_claude_code_share_ok: true
- selector_anthropic_primary_zero_ok: true
- selector_anthropic_chain_zero_ok: true
- runtime_anthropic_zero_ok: true
- runtime_failed_rate_ok: true
- runtime_oauth_seen_ok: true
- reported_cost_accounting_only: true

## Warnings

- runtime_reported_cost_is_accounting_or_cli_imputed_cost_not_oauth4_billing_gate
- runtime_claude_code_share_depends_on_traffic_mix_selector_share_used_for_pass_fail
- non_oauth_runtime_cost_observed_groq_or_other_fallback_usage
