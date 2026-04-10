'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');

try {
  module.exports = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/rag-accumulator.ts'));
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' && error?.code !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
    throw error;
  }
  module.exports = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/rag-accumulator.ts'));
}
