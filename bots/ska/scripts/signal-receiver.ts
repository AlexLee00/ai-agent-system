// Shared Sigma advisory signal feed consumer for ska team.
// Tier 1: advisory signal 수신 후 로그만, 자동 행동 없음.
import * as http from 'http';
import { fileURLToPath } from 'url';

const SIGNAL_HUB_URL = process.env.TJ_SIGNAL_HUB_URL || 'http://localhost:4010';
const TEAM = 'ska';
let lastSince = new Date(Date.now() - 60_000).toISOString();

async function pollSignals() {
  const url = `${SIGNAL_HUB_URL}/sigma/signals?team=${TEAM}&since=${encodeURIComponent(lastSince)}`;
  return new Promise<void>((resolve) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const signals: unknown[] = parsed?.signals || [];
          if (signals.length > 0) {
            console.log(`[shared-signal.${TEAM}] ${signals.length}건 수신`);
            signals.forEach((s) => console.log('[shared-signal]', JSON.stringify(s)));
            lastSince = new Date().toISOString();
          }
        } catch {
          // ignore parse errors
        }
        resolve();
      });
    }).on('error', () => resolve());
  });
}

async function run() {
  console.log(`[shared-signal-receiver] ${TEAM} 팀 sigma advisory polling 시작`);
  while (true) {
    await pollSignals();
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

function isDirectExecution() {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  run();
}
