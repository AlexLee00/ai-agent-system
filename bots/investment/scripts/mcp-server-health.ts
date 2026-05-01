#!/usr/bin/env node
// @ts-nocheck

import { buildGuardrailResult, defineGuardrailCli, fetchJson } from './guardrail-check-common.ts';

export async function runMcpServerHealth() {
  const port = Number(process.env.LUNA_MARKETDATA_MCP_PORT || 4088);
  const url = `http://127.0.0.1:${port}/health`;
  const health = await fetchJson(url, { timeoutMs: 5000 });
  return buildGuardrailResult({
    name: 'mcp_server_health',
    severity: 'medium',
    owner: 'system',
    blockers: health.ok ? [] : [`mcp_health_unavailable:${health.status || 'network_error'}`],
    evidence: {
      url,
      status: health.status,
      body: health.body || null,
      error: health.error || null,
    },
  });
}

defineGuardrailCli(import.meta.url, {
  name: 'mcp_server_health',
  run: runMcpServerHealth,
});
