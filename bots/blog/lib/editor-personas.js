'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');

try {
  module.exports = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/editor-personas.ts'));
} catch (_error) {
  module.exports = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/editor-personas.ts'));
}
