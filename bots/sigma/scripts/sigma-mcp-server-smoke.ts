import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const repoPlist = path.join(repoRoot, 'bots/sigma/launchd/ai.sigma.mcp-server.plist');
const installedPlist = path.join(os.homedir(), 'Library/LaunchAgents/ai.sigma.mcp-server.plist');

function readLaunchdEnv(plistPath: string): Record<string, string> {
  const output = execFileSync('/usr/bin/plutil', [
    '-extract',
    'EnvironmentVariables',
    'json',
    '-o',
    '-',
    plistPath,
  ], { encoding: 'utf8' });
  return JSON.parse(output);
}

function isPlaceholder(value: string | undefined): boolean {
  return !value || /^__.*__$/.test(value) || /set[_-]?in[_-]?local/i.test(value);
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

const repoEnv = readLaunchdEnv(repoPlist);
assert.equal(repoEnv.SIGMA_V2_ENABLED, 'true');
assert.equal(repoEnv.SIGMA_MCP_SERVER_ENABLED, 'true');
assert.equal(repoEnv.SIGMA_HTTP_PORT, '4000');
assert.equal(repoEnv.SIGMA_MAPEK_ENABLED, 'false');
assert.equal(repoEnv.SIGMA_MCP_TOKEN, '__SET_IN_LOCAL_LAUNCHAGENT__');

let runtime: any = null;
if (process.env.SIGMA_MCP_SERVER_SMOKE_RUNTIME === '1') {
  const runtimeEnv = readLaunchdEnv(installedPlist);
  const token = runtimeEnv.SIGMA_MCP_TOKEN;
  assert.equal(runtimeEnv.SIGMA_HTTP_PORT, '4000');
  assert.equal(runtimeEnv.SIGMA_MCP_SERVER_ENABLED, 'true');
  assert.equal(isPlaceholder(token), false, 'installed Sigma MCP token must be non-placeholder');

  const baseUrl = `http://127.0.0.1:${runtimeEnv.SIGMA_HTTP_PORT}`;
  const healthResponse = await fetch(`${baseUrl}/sigma/v2/health`);
  const health = await readJson(healthResponse);
  assert.equal(healthResponse.status, 200);
  assert.equal(health.status, 'ok');
  assert.equal(health.http_port, '4000');

  const unauthorizedResponse = await fetch(`${baseUrl}/mcp/sigma/tools`);
  assert.equal(unauthorizedResponse.status, 401);

  const toolsResponse = await fetch(`${baseUrl}/mcp/sigma/tools`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const tools = await readJson(toolsResponse);
  assert.equal(toolsResponse.status, 200);
  assert.equal(Array.isArray(tools.tools), true);
  assert.equal(tools.tools.length, 5);

  const callResponse = await fetch(`${baseUrl}/mcp/sigma/tools/causal_check/call`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      claim: 'A routing change improved Luna entry quality',
      correlation: 0.72,
      controls: ['market_regime'],
      confounders: ['sample_window'],
      sample_size: 500,
    }),
  });
  const call = await readJson(callResponse);
  assert.equal(callResponse.status, 200);
  assert.equal(typeof call.causal_risk, 'string');

  runtime = {
    baseUrl,
    health: health.status,
    toolCount: tools.tools.length,
    toolCallStatus: callResponse.status,
    unauthorizedStatus: unauthorizedResponse.status,
  };
}

console.log(JSON.stringify({
  ok: true,
  status: 'sigma_mcp_server_smoke_passed',
  repoPlist,
  repoPort: repoEnv.SIGMA_HTTP_PORT,
  runtime,
}, null, 2));
