'use strict';

const path = require('node:path');
const env = require('../../../../packages/core/lib/env');

const tsPath = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'lib', 'routes', 'secrets.ts');

try {
  module.exports = require(tsPath);
} catch (error) {
  if (error && (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_REQUIRE_ESM' || error.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX')) {
    module.exports = require('./secrets.legacy.js');
  } else {
    throw error;
  }
}
