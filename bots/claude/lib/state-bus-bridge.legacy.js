'use strict';

const fs = require('fs');
const path = require('path');

function resolveStateBusModule() {
  const projectRoot = process.env.PROJECT_ROOT || '';
  const candidates = [
    path.join(__dirname, '../../reservation/lib/state-bus.js'),
    path.join(__dirname, '../../reservation/lib/state-bus.legacy.js'),
    projectRoot ? path.join(projectRoot, 'bots/reservation/lib/state-bus.js') : '',
    projectRoot ? path.join(projectRoot, 'bots/reservation/lib/state-bus.legacy.js') : '',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error('[claude] state-bus bridge target not found');
}

module.exports = require(resolveStateBusModule());
