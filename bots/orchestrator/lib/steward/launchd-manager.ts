// @ts-nocheck
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const env = require('../../../../packages/core/lib/env');
const {
  getServiceOwnership,
  isExpectedIdleService,
  isOptionalService,
} = require('../../../../packages/core/lib/service-ownership');

const LAUNCHD_DIR = path.join(process.env.HOME || '', 'Library', 'LaunchAgents');

function listOurServices() {
  try {
    const output = execSync('launchctl list', { stdio: 'pipe', encoding: 'utf8' });
    return output
      .split('\n')
      .filter((line) => line.includes('ai.'))
      .map((line) => {
        const [pid = '-', status = '-', label = ''] = line.split('\t');
        return { pid, status, label };
      })
      .filter((item) => item.label);
  } catch (error) {
    console.warn(`[steward/launchd] launchctl list 실패: ${error.message}`);
    return [];
  }
}

function getLaunchAgentPlistPath(label) {
  const local = path.join(LAUNCHD_DIR, `${label}.plist`);
  if (fs.existsSync(local)) return local;
  return null;
}

function readPlistJson(plistPath) {
  try {
    const raw = execSync(`plutil -convert json -o - "${plistPath}"`, {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isScheduledOnlyService(label) {
  const plistPath = getLaunchAgentPlistPath(label);
  if (!plistPath) return false;
  const plist = readPlistJson(plistPath);
  if (!plist) return false;
  const hasSchedule = Boolean(plist.StartCalendarInterval || plist.StartInterval);
  const keepAlive = plist.KeepAlive;
  const runAtLoad = plist.RunAtLoad === true;
  return hasSchedule && !keepAlive && !runAtLoad;
}

function shouldSuppressUnhealthy(service) {
  if (!service?.label) return false;
  if (isExpectedIdleService(service.label) || isOptionalService(service.label)) return true;
  if (isScheduledOnlyService(service.label)) return true;
  const ownership = getServiceOwnership(service.label);
  if (ownership?.retired) return true;
  return false;
}

function checkHealth() {
  const services = listOurServices();
  const restarted = services.filter((service) => service.pid !== '-' && service.status !== '0');
  const unhealthy = services
    .filter((service) => service.pid === '-' && service.status !== '0')
    .filter((service) => !shouldSuppressUnhealthy(service));
  return {
    total: services.length,
    running: services.filter((service) => service.pid !== '-').length,
    restarted,
    unhealthy,
  };
}

function listPlistFiles() {
  const dirs = [
    'bots/blog/launchd',
    'bots/claude/launchd',
    'bots/hub/launchd',
    'bots/investment/launchd',
    'bots/orchestrator/launchd',
    'bots/reservation/launchd',
  ].map((dir) => path.join(env.PROJECT_ROOT, dir));

  const found = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.plist'))) {
      found.push({
        name: file,
        dir,
        registered: fs.existsSync(path.join(LAUNCHD_DIR, file)),
      });
    }
  }
  return found;
}

module.exports = {
  listOurServices,
  checkHealth,
  listPlistFiles,
};
