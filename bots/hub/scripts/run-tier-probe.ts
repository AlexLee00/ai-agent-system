// @ts-nocheck
/**
 * run-tier-probe.ts — Hub LLM 티어 회로 복구 프로브
 *
 * POST /hub/llm/tier-probe 를 호출해 OPEN/HALF_OPEN 로컬 프로바이더를 능동 복구.
 * launchd: ai.hub.llm-tier-probe (5분 간격)
 */

import fs from 'fs';
import path from 'path';

const env = require('../../../packages/core/lib/env');

const STORE_PATH = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'secrets-store.json');
const HUB_PORT = process.env.HUB_PORT || '7788';
const PROBE_URL = `http://127.0.0.1:${HUB_PORT}/hub/llm/tier-probe`;

function loadAuthToken(): string {
  const fromEnv = (process.env.HUB_AUTH_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return (store?.hub?.auth_token || '').trim();
  } catch {
    return '';
  }
}

async function main() {
  const token = loadAuthToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const resp = await fetch(PROBE_URL, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    const ts = new Date().toISOString();
    if (data.ok) {
      console.log(`[tier-probe] ${ts} circuits=${data.total_circuits} non_closed=${data.non_closed} recovered=${data.recovered}`);
      for (const r of (data.results || [])) {
        const mark = r.action === 'reset' ? '✅' : r.action === 'skip' ? '—' : '⚠️';
        console.log(`  ${mark} ${r.provider}: ${r.state} → ${r.action} (${r.reason})`);
      }
    } else {
      console.error(`[tier-probe] ${ts} 응답 이상:`, JSON.stringify(data));
    }
  } catch (err: any) {
    console.error(`[tier-probe] ${new Date().toISOString()} 호출 실패:`, err.message);
  }
}

main();
