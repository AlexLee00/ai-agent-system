'use strict';

const fs = require('fs');
const path = require('path');

function resolveCriticalIncidentModule() {
  const projectRoot = process.env.PROJECT_ROOT || '';
  const candidates = [
    path.join(__dirname, '../../../packages/core/lib/critical-incident.js'),
    path.join(__dirname, '../../../packages/core/lib/critical-incident.legacy.js'),
    projectRoot ? path.join(projectRoot, 'packages/core/lib/critical-incident.js') : '',
    projectRoot ? path.join(projectRoot, 'packages/core/lib/critical-incident.legacy.js') : '',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error('[blog] critical-incident bridge target not found');
}

module.exports = require(resolveCriticalIncidentModule());
