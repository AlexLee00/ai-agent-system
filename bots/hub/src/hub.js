'use strict';

const path = require('node:path');
const env = require('../../../packages/core/lib/env');

const tsPath = path.join(env.PROJECT_ROOT, 'bots', 'hub', 'src', 'hub.ts');

try {
  require(tsPath);
} catch (error) {
  if (error && (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_REQUIRE_ESM' || error.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX')) {
    require('./hub.legacy.js');
  } else {
    throw error;
  }
}
