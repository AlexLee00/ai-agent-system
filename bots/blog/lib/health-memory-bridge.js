'use strict';

const fs = require('fs');
const path = require('path');

function resolveHealthMemoryModule() {
  const projectRoot = process.env.PROJECT_ROOT || '';
  const candidates = [
    path.join(__dirname, '../../../packages/core/lib/health-memory.js'),
    path.join(__dirname, '../../../packages/core/lib/health-memory.legacy.js'),
    projectRoot ? path.join(projectRoot, 'packages/core/lib/health-memory.js') : '',
    projectRoot ? path.join(projectRoot, 'packages/core/lib/health-memory.legacy.js') : '',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error('[blog] health-memory bridge target not found');
}

module.exports = require(resolveHealthMemoryModule());
