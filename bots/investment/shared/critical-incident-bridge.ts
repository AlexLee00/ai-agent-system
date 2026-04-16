'use strict';

import fs from 'fs';
import path from 'path';

function resolveCriticalIncidentModule(): string {
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

  throw new Error('[investment] critical-incident bridge target not found');
}

const criticalIncident = require(resolveCriticalIncidentModule());

module.exports = criticalIncident;
