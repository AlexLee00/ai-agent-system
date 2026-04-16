'use strict';

const path = require('path');
process.env.PG_DIRECT = process.env.PG_DIRECT || 'true';

const runtimePath = path.join(
  __dirname,
  '../../../dist/ts-runtime/bots/claude/src/claude-commander.js',
);

try {
  module.exports = require(runtimePath);
} catch (error) {
  if (error && error.code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
  module.exports = require('./claude-commander.legacy.js');
}
