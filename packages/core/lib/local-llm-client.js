'use strict';

const path = require('node:path');
const env = require('./env');

try {
  module.exports = require(path.join(env.PROJECT_ROOT, 'packages/core/lib/local-llm-client.ts'));
} catch (error) {
  if (error && (
    error.code === 'MODULE_NOT_FOUND' ||
    error.code === 'ERR_REQUIRE_ESM' ||
    error.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' ||
    /Unexpected identifier|Cannot use import statement/i.test(String(error.message || ''))
  )) {
    module.exports = require('./local-llm-client.legacy.js');
  } else {
    throw error;
  }
}
