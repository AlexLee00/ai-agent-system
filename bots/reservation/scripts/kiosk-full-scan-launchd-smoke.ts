// @ts-nocheck
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RESERVATION_ROOT = path.resolve(__dirname, '..');
const WRAPPER = path.join(RESERVATION_ROOT, 'auto/monitors/run-kiosk-full-scan.sh');
const PLIST = path.join(RESERVATION_ROOT, 'launchd/ai.ska.kiosk-full-scan.plist');
const START_OPS = path.join(RESERVATION_ROOT, 'auto/monitors/start-ops.sh');
const DEPLOY_OPS = path.join(RESERVATION_ROOT, 'scripts/deploy-ops.sh');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function main() {
  assert.ok(fs.existsSync(WRAPPER), 'full-scan wrapper must exist');
  assert.ok(fs.existsSync(PLIST), 'full-scan launchd plist must exist');

  const wrapper = read(WRAPPER);
  const startOps = read(START_OPS);
  const deployOps = read(DEPLOY_OPS);
  assert.ok(
    wrapper.includes('KIOSK_PICKKO_PAID_DATE_FALLBACK_ENABLED=1'),
    'full scan wrapper must force paid date fallback',
  );
  assert.ok(
    wrapper.includes('pickko-kiosk-monitor.lock'),
    'full scan must share the regular kiosk monitor lock',
  );
  assert.ok(
    wrapper.includes('pickko-kiosk-full-scan'),
    'full scan must write a distinct log',
  );

  execFileSync('plutil', ['-lint', PLIST], { stdio: 'pipe' });
  const plistText = read(PLIST);
  assert.ok(plistText.includes('<string>ai.ska.kiosk-full-scan</string>'), 'plist label must match');
  assert.ok(plistText.includes('<integer>3</integer>'), 'plist must run during the 03 hour');
  assert.ok(plistText.includes('<integer>35</integer>'), 'plist must run once at minute 35');
  assert.ok(plistText.includes('run-kiosk-full-scan.sh'), 'plist must call the full-scan wrapper');
  assert.ok(
    startOps.includes('KIOSK_FULL_SCAN_SOURCE_PLIST') && startOps.includes('"$KIOSK_FULL_SCAN_SOURCE_PLIST"'),
    'start-ops must install the repo full-scan plist before launchd bootstrap',
  );
  assert.ok(
    deployOps.includes('KIOSK_FULL_SCAN_SOURCE_PLIST') && deployOps.includes('"$KIOSK_FULL_SCAN_SOURCE_PLIST"'),
    'deploy-ops must install the repo full-scan plist before launchd bootstrap',
  );

  console.log('kiosk_full_scan_launchd_smoke_ok');
}

main();
