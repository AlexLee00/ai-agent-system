# Hub Ops MCP

Read-only MCP facade for Hub operational inspection.

## Tools

- `hub-health`: proxy `/hub/health/live`.
- `hub-metrics`: compact `/hub/metrics` Prometheus output.
- `hub-circuit`: proxy `/hub/llm/circuit`.
- `hub-routing`: inspect a selector chain via `selectLLMChain`.
- `hub-cost`: summarize recent `public.llm_routing_log` cost/call rows with SELECT only.

## Local HTTP Registration

This service exposes a local HTTP JSON-RPC endpoint. It is not a stdio MCP
transport, so do not register `src/server.ts` directly as a command-based
`mcpServers` entry. Start it with launchd or npm, then point an HTTP-capable MCP
bridge/client at the local endpoint:

```sh
npm --prefix /Users/alexlee/projects/ai-agent-system/bots/hub run -s mcp:hub-ops
curl -sS http://127.0.0.1:4095/health
curl -sS http://127.0.0.1:4095/rpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`HUB_AUTH_TOKEN` may be supplied by the caller environment for authenticated Hub endpoints.
