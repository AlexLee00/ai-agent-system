'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');

const STRATEGY_PATH = path.join(env.PROJECT_ROOT, 'bots/blog/output/strategy/latest-strategy.json');

function loadLatestStrategy() {
  try {
    if (!fs.existsSync(STRATEGY_PATH)) return null;
    const raw = fs.readFileSync(STRATEGY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.plan || null;
  } catch {
    return null;
  }
}

module.exports = {
  STRATEGY_PATH,
  loadLatestStrategy,
};
