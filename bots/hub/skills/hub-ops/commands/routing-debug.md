# Routing Debug

1. Query `/hub/llm/selector?key=<selector>` or hub-ops-mcp `hub-routing`.
2. Capture `selectorKey`, `routingSource`, `runtimeProfile`, `effectiveTimeoutMs`, and chain.
3. If the selector is missing, verify whether `hub._default` was used with a fallback warning.
4. Check `public.llm_routing_log` read-only for recent `error`, `fallback_count`, `selected_route`.
5. If Gemini is absent, confirm `HUB_LLM_GEMINI_DISABLED` before treating it as a bug.

Never patch a caller to pass ad-hoc chains unless a master-approved exception exists.
