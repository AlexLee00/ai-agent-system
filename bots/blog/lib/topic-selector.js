'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');

try {
  const mod = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/topic-selector.ts'));
  module.exports = mod;
} catch (_error) {
  module.exports = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/topic-selector.ts'));
}
