'use strict';

const path = require('path');
const env = require('../../../../packages/core/lib/env');

try {
  module.exports = require(path.join(env.PROJECT_ROOT, 'bots/hub/lib/routes/secrets.ts'));
} catch (error) {
  if (error && (error.code === 'MODULE_NOT_FOUND' || error.code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX')) {
    module.exports = require('./secrets.legacy.js');
  } else {
    throw error;
  }
}
