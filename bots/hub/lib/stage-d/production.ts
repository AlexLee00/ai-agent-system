// @ts-nocheck
/**
 * production.ts — Stage D Production Promotion Gate
 *
 * Task D8: 모든 Stage A-D 게이트 통합 검증.
 * Stage B/C report 파일 + Stage D 인프라 존재 여부 + 운영 지표 확인.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PROJECT_ROOT = path.resolve(__dirname, '../../../..');
const HUB_DIR = path.join(PROJECT_ROOT, 'bots/hub');
const OUTPUT_PATH = path.join(HUB_DIR, 'output', 'hub-stage-d-production-report.json');

function fileExists(rel) {
  return fs.existsSync(path.join(PROJECT_ROOT, rel));
}

function httpGet(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'GET', timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.end();
  });
}

async function checkBlueGreen() {
  const bgStateFile = '/tmp/hub-bg-state.json';
  let state = { active: 'blue' };
  try {
    state = JSON.parse(fs.readFileSync(bgStateFile, 'utf8'));
  } catch {}

  const blueHealth = await httpGet(7788, '/hub/health/live');
  const proxyPlistExists = fileExists('bots/hub/launchd/ai.hub.bg-proxy.plist');
  const greenPlistExists = fileExists('bots/hub/launchd/ai.hub.resource-api-green.plist');
  const deployScriptExists = fileExists('bots/hub/scripts/hub-blue-green-deploy.ts');

  const checks = [
    { name: 'blue_healthy', ok: blueHealth.status === 200, evidence: `HTTP ${blueHealth.status}` },
    { name: 'green_plist_exists', ok: greenPlistExists },
    { name: 'proxy_plist_exists', ok: proxyPlistExists },
    { name: 'deploy_script_exists', ok: deployScriptExists },
  ];

  return {
    ok: checks.every((c) => c.ok),
    activeSlot: state.active,
    switchedAt: state.switchedAt || null,
    checks,
  };
}

function checkSecretsAutoRotate() {
  const checks = [
    { name: 'rotation_log_migration_exists', ok: fileExists('bots/hub/migrations/20261001000070_hub_secrets_rotation_log.sql') },
    { name: 'monitor_library_exists', ok: fileExists('bots/hub/lib/secrets-store-monitor.ts') },
    { name: 'monitor_runner_exists', ok: fileExists('bots/hub/scripts/secrets-store-monitor-runner.ts') },
    { name: 'auto_rotate_plist_exists', ok: fileExists('bots/hub/launchd/ai.hub.secrets-auto-rotate.plist') },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

function checkStageBReport() {
  const reportPath = 'bots/hub/output/hub-stage-b-stability-report.json';
  if (!fileExists(reportPath)) {
    return { ok: false, error: 'Stage B report not found' };
  }
  try {
    const report = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, reportPath), 'utf8'));
    return { ok: report.ok === true, status: report.status || 'unknown' };
  } catch {
    return { ok: false, error: 'Stage B report parse failed' };
  }
}

function checkStageCReport() {
  const reportPath = 'bots/hub/output/hub-stage-c-resilience-report.json';
  if (!fileExists(reportPath)) {
    return { ok: false, error: 'Stage C report not found' };
  }
  try {
    const report = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, reportPath), 'utf8'));
    return { ok: report.ok === true, status: report.status || 'unknown' };
  } catch {
    return { ok: false, error: 'Stage C report parse failed' };
  }
}

async function checkHubUptime() {
  const blueHealth = await httpGet(7788, '/hub/health/startup');
  let uptimeSeconds = 0;
  let startupComplete = false;
  try {
    const body = JSON.parse(blueHealth.body);
    uptimeSeconds = body.uptime_seconds || 0;
    startupComplete = body.startup_complete === true;
  } catch {}

  return {
    ok: blueHealth.status === 200 && startupComplete,
    uptimeSeconds,
    startupComplete,
    httpStatus: blueHealth.status,
  };
}

async function buildHubStageDProductionReport(options = {}) {
  const checkedAt = new Date().toISOString();

  const [blueGreen, uptime] = await Promise.all([
    checkBlueGreen(),
    checkHubUptime(),
  ]);

  const secretsRotate = checkSecretsAutoRotate();
  const stageB = checkStageBReport();
  const stageC = checkStageCReport();

  const goals = {
    stageA_llmControlPlane: stageB.ok,  // B report implies A passed
    stageB_stability: stageB.ok,
    stageC_resilience: stageC.ok,
    stageD_blueGreen: blueGreen.ok,
    stageD_secretsAutoRotate: secretsRotate.ok,
    // D3-D7: Phase 1 shadow (pending in Week 1)
    stageD_selfHealing: false,
    stageD_drpActual: false,
    stageD_liveChaos: false,
    stageD_sentryIntegration: false,
    stageD_externalGateway: false,
  };

  const week1Complete = goals.stageD_blueGreen && goals.stageD_secretsAutoRotate;

  const report = {
    ok: false,
    checkedAt,
    stage: 'hub_stage_d',
    status: 'stage_d_week1',
    week1Complete,
    goals,
    details: {
      stageB,
      stageC,
      blueGreen,
      secretsAutoRotate: secretsRotate,
      uptime,
    },
    roadmap: {
      week1: ['D1_blue_green', 'D2_secrets_auto_rotate'],
      week2: ['D3_self_healing_phase1'],
      week3: ['D4_drp_actual', 'D6_sentry'],
      week4: ['D7_external_gateway', 'D5_chaos_phase1'],
      week5: ['D5_chaos_phase2_3'],
      week6: ['D8_production_promotion_gate'],
    },
    safetyBoundary: {
      noProtectedRestart: true,
      noSecretMutation: true,
      noProductionRestore: true,
      blueNeverStopped: true,
    },
  };

  report.ok = week1Complete && stageB.ok && stageC.ok;
  report.status = report.ok ? 'stage_d_week1_complete' : 'stage_d_week1_in_progress';

  return report;
}

async function writeHubStageDReport(report, outputPath = OUTPUT_PATH) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return outputPath;
}

module.exports = {
  OUTPUT_PATH,
  buildHubStageDProductionReport,
  writeHubStageDReport,
  checkBlueGreen,
  checkSecretsAutoRotate,
};
