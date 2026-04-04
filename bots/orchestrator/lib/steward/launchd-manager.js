'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const env = require('../../../../packages/core/lib/env');

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

function checkHealth() {
  const services = listOurServices();
  const unhealthy = services.filter((service) => service.status !== '0');
  return {
    total: services.length,
    running: services.filter((service) => service.pid !== '-').length,
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
    'bots/worker/launchd',
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
