# LLM OAuth4 Master Review

- generated_at: 2026-05-28T04:33:06.944Z
- hours: 168
- stats_source: hub_http
- total_calls: 76775
- oauth_share_pct: 70.87
- failed_rate_pct: 0.1
- reported_cost_usd: 5.746976
- oauth_reported_cost_usd: 0.725558
- claude_code_reported_cost_usd: 0.725558
- claude_code_runtime_cost_share_pct: 12.63
- non_oauth_reported_cost_usd: 5.021418
- anthropic_provider_calls: 0
- selector_claude_code_primary_share_pct: 3.47
- selector_claude_code_sonnet_primary_share_pct: 0

| Provider | Calls | Share % | Success % | Avg ms | Cost USD |
|---|---:|---:|---:|---:|---:|
| Claude Code OAuth | 17 | 0.02 | 100.00 | 28748 | 0.725558 |
| OpenAI OAuth | 47974 | 62.49 | 100.00 | 2324 | 0.000000 |
| Gemini CLI OAuth | 6418 | 8.36 | 100.00 | 14660 | 0.000000 |
| Anthropic SDK | 0 | 0.00 | 0.00 | 0 | 0.000000 |
| Groq | 13566 | 17.67 | 100.00 | 1439 | 5.021418 |
| Failed | 73 | 0.10 | 0.00 | 12741 | 0.000000 |

## Selector Matrix

- selector_version: v3.0_oauth_4
- checked_selector_keys: 83
- checked_agent_routes: 90
- selector_primary_provider_counts: {"openai-oauth":74,"claude-code":6,"groq":84,"local-embedding":2,"local":4,"gemini-cli-oauth":3}
- selector_primary_provider_shares: {"claude-code":3.47,"gemini-cli-oauth":1.73,"groq":48.55,"local":2.31,"local-embedding":1.16,"openai-oauth":42.77}
- selector_primary_model_counts: {"openai-oauth/gpt-5.4-mini":27,"claude-code/haiku":6,"openai-oauth/gpt-5.4":47,"groq/llama-3.1-8b-instant":64,"local-embedding/qwen3-embed-0.6b":2,"local/qwen2.5-7b":4,"gemini-cli-oauth/gemini-2.5-pro":1,"gemini-cli-oauth/gemini-2.5-flash":2,"groq/qwen/qwen3-32b":18,"groq/openai/gpt-oss-20b":2}
- selector_primary_model_shares: {"claude-code/haiku":3.47,"gemini-cli-oauth/gemini-2.5-flash":1.16,"gemini-cli-oauth/gemini-2.5-pro":0.58,"groq/llama-3.1-8b-instant":36.99,"groq/openai/gpt-oss-20b":1.16,"groq/qwen/qwen3-32b":10.4,"local-embedding/qwen3-embed-0.6b":1.16,"local/qwen2.5-7b":2.31,"openai-oauth/gpt-5.4":27.17,"openai-oauth/gpt-5.4-mini":15.61}

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
