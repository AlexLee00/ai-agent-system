# Resilience Runbook

Default behavior is unchanged while `HUB_RESILIENCE_ENABLED=false`.

When enabled:

- Provider circuit trips after 5 counted failures.
- Cooldown is 60 seconds.
- Fallback order is bounded by the selector chain.
- Local terminal fallback is allowed only if already present in the chain.

Always verify crypto and SKA route smoke before proposing activation.
