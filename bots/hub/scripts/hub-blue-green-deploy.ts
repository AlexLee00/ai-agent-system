// @ts-nocheck
/**
 * hub-blue-green-deploy.ts — Hub Blue-Green 배포 자동화
 *
 * 사용법:
 *   npm run hub:bg-status              — 현재 상태 조회
 *   npm run hub:bg-deploy              — Green 인스턴스 시작 + 헬스 확인
 *   npm run hub:bg-switch -- --to=green — 트래픽 Green으로 전환
 *   npm run hub:bg-switch -- --to=blue  — 트래픽 Blue로 전환
 *   npm run hub:bg-rollback             — 즉시 Blue로 롤백
 *   npm run hub:bg-promote             — Green → Blue 승격 (Green 코드를 Blue로!)
 *
 * 포트:
 *   Blue  → 7788 (stable, ai.hub.resource-api)
 *   Green → 7789 (new, ai.hub.resource-api-green)
 *   Proxy → 7780 (router, ai.hub.bg-proxy)
 *
 * 상태 파일: /tmp/hub-bg-state.json
 */

import { execSync, spawnSync } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const STATE_FILE = '/tmp/hub-bg-state.json';
const BLUE_PORT = 7788;
const GREEN_PORT = 7789;
const PROXY_PORT = 7780;
const HEALTH_TIMEOUT_MS = 5000;
const HEALTH_MAX_RETRIES = 12;
const HEALTH_RETRY_INTERVAL_MS = 5000;

const PROJECT_ROOT = path.resolve(__dirname, '../../..');

interface BgState {
  active: 'blue' | 'green';
  switchedAt?: string;
  switchedBy?: string;
  greenDeployedAt?: string;
}

function readState(): BgState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { active: 'blue' };
  }
}

function writeState(state: BgState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function launchctlCmd(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync('launchctl', args, { encoding: 'utf8', timeout: 15000 });
  return {
    ok: result.status === 0,
    output: (result.stdout || '') + (result.stderr || ''),
  };
}

function isServiceRunning(label: string): boolean {
  const result = launchctlCmd(['list', label]);
  return result.ok && result.output.includes('"Label"');
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', timeout: HEALTH_TIMEOUT_MS },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function waitForHealth(port: number, slot: string): Promise<boolean> {
  console.log(`[bg-deploy] ${slot}(${port}) 헬스 확인 시작 (최대 ${HEALTH_MAX_RETRIES}회)...`);
  for (let i = 1; i <= HEALTH_MAX_RETRIES; i++) {
    try {
      const { status } = await httpGet(port, '/hub/health/live');
      if (status === 200) {
        console.log(`[bg-deploy] ✅ ${slot}(${port}) healthy (${i}/${HEALTH_MAX_RETRIES})`);
        return true;
      }
      console.log(`[bg-deploy] ${slot}(${port}) HTTP ${status} (${i}/${HEALTH_MAX_RETRIES})`);
    } catch (err: any) {
      console.log(`[bg-deploy] ${slot}(${port}) 연결 실패: ${err.message} (${i}/${HEALTH_MAX_RETRIES})`);
    }
    if (i < HEALTH_MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, HEALTH_RETRY_INTERVAL_MS));
    }
  }
  return false;
}

function printStatus(): void {
  const state = readState();
  const blueRunning = isServiceRunning('ai.hub.resource-api');
  const greenRunning = isServiceRunning('ai.hub.resource-api-green');
  const proxyRunning = isServiceRunning('ai.hub.bg-proxy');

  console.log('\n=== Hub Blue-Green 상태 ===');
  console.log(`현재 트래픽: ${state.active.toUpperCase()}`);
  console.log(`  Blue  (7788) : ${blueRunning ? '✅ running' : '❌ stopped'}`);
  console.log(`  Green (7789) : ${greenRunning ? '✅ running' : '⬜ stopped'}`);
  console.log(`  Proxy (7780) : ${proxyRunning ? '✅ running' : '⬜ stopped'}`);
  if (state.switchedAt) console.log(`  전환 시각: ${state.switchedAt}`);
  if (state.greenDeployedAt) console.log(`  Green 배포: ${state.greenDeployedAt}`);
  console.log('');
}

async function deploy(): Promise<void> {
  console.log('[bg-deploy] Green 인스턴스 배포 시작...');

  const blueRunning = isServiceRunning('ai.hub.resource-api');
  if (!blueRunning) {
    console.error('[bg-deploy] ❌ Blue(ai.hub.resource-api)가 실행 중이 아닙니다. 배포 중단.');
    process.exit(1);
  }

  // 기존 Green이 실행 중이면 먼저 중지
  if (isServiceRunning('ai.hub.resource-api-green')) {
    console.log('[bg-deploy] 기존 Green 인스턴스 중지...');
    launchctlCmd(['unload', path.join(PROJECT_ROOT, 'bots/hub/launchd/ai.hub.resource-api-green.plist')]);
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Green 시작
  const loadResult = launchctlCmd([
    'load',
    path.join(PROJECT_ROOT, 'bots/hub/launchd/ai.hub.resource-api-green.plist'),
  ]);
  if (!loadResult.ok) {
    console.error('[bg-deploy] ❌ Green launchd load 실패:', loadResult.output);
    process.exit(1);
  }
  console.log('[bg-deploy] Green launchd 로드 완료');

  // 헬스 대기
  const healthy = await waitForHealth(GREEN_PORT, 'green');
  if (!healthy) {
    console.error('[bg-deploy] ❌ Green 헬스 확인 실패 — 롤백!');
    launchctlCmd(['unload', path.join(PROJECT_ROOT, 'bots/hub/launchd/ai.hub.resource-api-green.plist')]);
    process.exit(1);
  }

  // 상태 업데이트
  const state = readState();
  state.greenDeployedAt = new Date().toISOString();
  writeState(state);

  console.log('[bg-deploy] ✅ Green 배포 완료!');
  console.log('[bg-deploy]    트래픽 전환: npm run hub:bg-switch -- --to=green');
}

async function switchTraffic(to: 'blue' | 'green'): Promise<void> {
  const targetPort = to === 'green' ? GREEN_PORT : BLUE_PORT;
  const targetLabel = to === 'green' ? 'ai.hub.resource-api-green' : 'ai.hub.resource-api';

  if (!isServiceRunning(targetLabel)) {
    console.error(`[bg-switch] ❌ ${to}(${targetLabel})가 실행 중이 아닙니다.`);
    process.exit(1);
  }

  const healthy = await waitForHealth(targetPort, to);
  if (!healthy) {
    console.error(`[bg-switch] ❌ ${to} 헬스 확인 실패 — 전환 중단`);
    process.exit(1);
  }

  const state = readState();
  const prev = state.active;
  state.active = to;
  state.switchedAt = new Date().toISOString();
  state.switchedBy = 'hub-blue-green-deploy';
  writeState(state);

  console.log(`[bg-switch] ✅ 트래픽 전환 완료: ${prev} → ${to}`);
  console.log(`[bg-switch]    프록시(${PROXY_PORT})가 다음 요청부터 ${to}(${targetPort})로 라우팅합니다.`);
}

async function rollback(): Promise<void> {
  console.log('[bg-rollback] Blue로 즉시 롤백...');

  const blueRunning = isServiceRunning('ai.hub.resource-api');
  if (!blueRunning) {
    console.error('[bg-rollback] ❌ Blue가 실행 중이 아닙니다! 수동 복구 필요.');
    process.exit(1);
  }

  const state = readState();
  const prev = state.active;
  state.active = 'blue';
  state.switchedAt = new Date().toISOString();
  state.switchedBy = 'hub-blue-green-deploy:rollback';
  writeState(state);

  console.log(`[bg-rollback] ✅ 롤백 완료: ${prev} → blue`);
}

// CLI 파싱
const [, , command, ...rest] = process.argv;
const flags = Object.fromEntries(
  rest.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.slice(2).split('=');
    return [k, v ?? 'true'];
  })
);

(async () => {
  switch (command) {
    case 'status':
      printStatus();
      break;

    case 'deploy':
      await deploy();
      break;

    case 'switch': {
      const to = flags.to as 'blue' | 'green';
      if (to !== 'blue' && to !== 'green') {
        console.error('사용법: hub-blue-green-deploy switch --to=blue|green');
        process.exit(1);
      }
      await switchTraffic(to);
      break;
    }

    case 'rollback':
      await rollback();
      break;

    default:
      console.log(`사용법:
  hub-blue-green-deploy status
  hub-blue-green-deploy deploy
  hub-blue-green-deploy switch --to=green|blue
  hub-blue-green-deploy rollback`);
      process.exit(1);
  }
})();
