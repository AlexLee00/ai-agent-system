'use strict';

import fs from 'fs';
import path from 'path';

function resolveHealthMemoryModule(): string {
  const projectRoot = process.env.PROJECT_ROOT || '';
  const candidates = [
    path.join(__dirname, '../../../packages/core/lib/health-memory.js'),
    path.join(__dirname, '../../../packages/core/lib/health-memory.legacy.js'),
    projectRoot ? path.join(projectRoot, 'packages/core/lib/health-memory.js') : '',
    projectRoot ? path.join(projectRoot, 'packages/core/lib/health-memory.legacy.js') : '',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('[reservation] health-memory bridge target not found');
}

const healthMemory = require(resolveHealthMemoryModule());

module.exports = healthMemory;
