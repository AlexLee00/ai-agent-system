#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const {
  parseArgs,
  resolvePublishLogSafetyMetadata,
  buildLunaEvidenceContentPreview,
  buildLunaEvidenceSummary,
  postUrlFor,
  shouldSendPublishSuccessTelegram,
} = require('../lib/edux-runtime-support.ts');

const EDUX_ROOT = path.join(env.PROJECT_ROOT, 'bots', 'edu-x');

function runScript(script, args = [], extraEnv = {}) {
  const stdout = execFileSync(process.execPath, [path.join(EDUX_ROOT, 'scripts', script), '--fixture', '--dry-run', '--json', ...args], {
    cwd: EDUX_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      EDUX_SKIP_DB: 'true',
      EDUX_DRY_RUN: 'true',
      EDUX_FORMATTER_FIXTURE: 'true',
      EDUX_DISABLE_TRADINGVIEW_READONLY: 'true',
      EDUX_DISABLE_TELEGRAM: 'true',
      ...extraEnv,
    },
    maxBuffer: 1024 * 1024 * 8,
  });
  assert(stdout.includes('"status": "dry_run"'), `${script} did not dry-run: ${stdout.slice(-500)}`);
  const result = JSON.parse(stdout.slice(stdout.indexOf('{')));
  assert(
    result.artifact?.mdPath?.includes('/output/dry-run/fixture/'),
    `${script} fixture dry-run must not overwrite production artifacts: ${result.artifact?.mdPath}`,
  );
  return { stdout, result };
}

function main() {
  const parsedTestArgs = parseArgs(['--test-post', '--exclude-from-luna-evidence']);
  assert.equal(parsedTestArgs.testPost, true, '--test-post must be parsed');
  assert.equal(parsedTestArgs.excludeFromLunaEvidence, true, '--exclude-from-luna-evidence must be parsed');
  assert.equal(
    postUrlFor('https://pulse.edu-x.io', 'post-123'),
    'https://edu-x.io/community/post-123',
    'public post URL must match Edu-X detail share-link route',
  );

  const oneOffSafety = resolvePublishLogSafetyMetadata({
    title: '[TEST] 05/20 BTC/USDT 시황 카드',
    metadata: { liveGate: { mode: 'one_off_live_test' } },
  });
  assert.equal(oneOffSafety.testPost, true, 'one-off live test must be flagged as testPost');
  assert.equal(oneOffSafety.excludeFromLunaEvidence, true, 'one-off live test must be excluded from Luna evidence');
  assert.equal(oneOffSafety.lunaEvidencePolicy, 'exclude_test_post');
  assert.equal(
    shouldSendPublishSuccessTelegram({ args: { oneOffLiveTest: true }, liveGate: { mode: 'one_off_live_test' } }),
    false,
    'one-off live test success telegram must be suppressed by default',
  );
  process.env.EDUX_NOTIFY_ONE_OFF_LIVE_TEST = 'true';
  assert.equal(
    shouldSendPublishSuccessTelegram({ args: { oneOffLiveTest: true }, liveGate: { mode: 'one_off_live_test' } }),
    true,
    'one-off live test success telegram can be explicitly enabled',
  );
  delete process.env.EDUX_NOTIFY_ONE_OFF_LIVE_TEST;

  const productionSafety = resolvePublishLogSafetyMetadata({
    title: '05/20 BTC/USDT 시황 카드',
    metadata: { liveGate: { mode: 'promotion_gate_pass' } },
  });
  assert.equal(productionSafety.testPost, false, 'normal publish must not be marked as testPost');
  assert.equal(productionSafety.excludeFromLunaEvidence, false, 'normal publish remains eligible for Luna shadow evidence');
  assert.equal(
    shouldSendPublishSuccessTelegram({ args: {}, liveGate: { mode: 'promotion_gate' } }),
    true,
    'normal publish success telegram remains enabled',
  );

  const htmlPreview = buildLunaEvidenceContentPreview({
    title: '05/20 BTC/USDT 시황 카드',
    content: '<p>⚡ 핵심 3줄</p><p>• BTC/USDT는 $104,200 지지와 $108,900 저항 사이입니다.</p><p>&nbsp;</p><p>🤖 인공지능 추천안</p><p>• 관찰 우선입니다.</p>',
  });
  assert(htmlPreview.includes('BTC/USDT는 $104,200 지지'), 'luna evidence preview should retain post content');
  const lunaSummary = buildLunaEvidenceSummary({ title: '05/20 BTC/USDT 시황 카드', content: htmlPreview });
  assert(lunaSummary.includes('BTC/USDT'), 'luna evidence summary should include market context');

  runScript('runtime-edux-crypto-daily.ts', ['--slot=0600']);
  runScript('runtime-edux-crypto-daily.ts', ['--slot=1400']);
  runScript('runtime-edux-crypto-daily.ts', ['--slot=2230']);
  runScript('runtime-edux-kis-daily.ts', ['--slot=0900']);
  runScript('runtime-edux-kis-daily.ts', ['--slot=1600'], { EDUX_TEST_NOW: '2026-06-12T07:00:00.000Z' });
  runScript('runtime-edux-overseas-daily.ts', ['--slot=2200']);
  runScript('runtime-edux-overseas-daily.ts', ['--slot=0630'], { EDUX_TEST_NOW: '2026-06-12T21:30:00.000Z' });
  console.log(JSON.stringify({ ok: true, slots: ['0600', '0630', '0900', '1400', '1600', '2200', '2230'] }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
