# Luna YAML Model Proposal

Generated: 2026-07-02T00:00:00.000Z

This file is proposal-only. It does not change YAML routing or live model behavior.

| agent | current YAML route | proposed route | gate |
| --- | --- | --- | --- |
| adaptive-risk | groq/qwen/qwen3-32b -> openai-oauth/gpt-5.4-mini | groq/qwen/qwen3-32b -> openai-oauth/gpt-5.4-mini | keep |
| argos | openai-oauth/gpt-5.4-mini -> groq/llama-3.3-70b-versatile | openai-oauth/gpt-5.4-mini -> groq/llama-3.3-70b-versatile | keep |
| aria | rule-based | rule-based | keep |
| athena | openai-oauth/gpt-5.4-mini -> groq/llama-3.3-70b-versatile | openai-oauth/gpt-5.4-mini -> groq/llama-3.3-70b-versatile | keep |
| budget | rule-based | rule-based | keep |
| chronos | local-embedding/qwen3-embed-0.6b | local-embedding/qwen3-embed-0.6b | keep |
| hanul | rule-based | rule-based | keep |
| hephaestos | rule-based | rule-based | keep |
| hermes | groq/llama-3.3-70b-versatile -> openai-oauth/gpt-5.4-mini | groq/llama-3.3-70b-versatile -> openai-oauth/gpt-5.4-mini | keep |
| kairos | openai-oauth/gpt-5.4 -> groq/qwen/qwen3-32b | openai-oauth/gpt-5.4 -> groq/qwen/qwen3-32b | keep |
| luna | openai-oauth/gpt-5.4 -> groq/llama-3.3-70b-versatile | openai-oauth/gpt-5.4 -> groq/llama-3.3-70b-versatile | keep |
| nemesis | groq/qwen/qwen3-32b -> openai-oauth/gpt-5.4-mini | groq/qwen/qwen3-32b -> openai-oauth/gpt-5.4-mini | keep |
| oracle | openai-oauth/gpt-5.4 -> groq/qwen/qwen3-32b | openai-oauth/gpt-5.4 -> groq/qwen/qwen3-32b | keep |
| reporter | openai-oauth/gpt-5.4-mini -> groq/llama-3.3-70b-versatile | openai-oauth/gpt-5.4-mini -> groq/llama-3.3-70b-versatile | keep |
| scout | openai-oauth/gpt-5.4-mini -> groq/llama-3.3-70b-versatile | openai-oauth/gpt-5.4-mini -> groq/llama-3.3-70b-versatile | keep |
| sentinel | openai-oauth/gpt-5.4-mini -> groq/llama-3.3-70b-versatile | openai-oauth/gpt-5.4-mini -> groq/llama-3.3-70b-versatile | keep |
| sophia | groq/llama-3.3-70b-versatile -> openai-oauth/gpt-5.4-mini | groq/llama-3.3-70b-versatile -> openai-oauth/gpt-5.4-mini | keep |
| stock-flow | groq/qwen/qwen3-32b -> openai-oauth/gpt-5.4-mini | groq/qwen/qwen3-32b -> openai-oauth/gpt-5.4-mini | keep |
| sweeper | groq/llama-3.1-8b-instant -> openai-oauth/gpt-5.4-mini | groq/llama-3.1-8b-instant -> openai-oauth/gpt-5.4-mini | keep |
| zeus | openai-oauth/gpt-5.4-mini -> groq/llama-3.3-70b-versatile | openai-oauth/gpt-5.4-mini -> groq/llama-3.3-70b-versatile | keep |

## Guardrails

- Actual YAML model changes require master approval.
- `LUNA_YAML_ROUTING_ENABLED` remains default OFF.
- Rule-based agents stay non-LLM unless a separate SPEC changes ownership.
- Gemini residue must stay 0 in the YAML runtime path.
