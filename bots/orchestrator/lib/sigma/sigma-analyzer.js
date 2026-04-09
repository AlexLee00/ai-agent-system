'use strict';

const path = require('path');

const runtimePath = path.join(__dirname, '../../../../dist/ts-runtime/bots/orchestrator/lib/sigma/sigma-analyzer.js');

try {
  module.exports = require(runtimePath);
} catch (error) {
  const isMissingRuntime = error && (
    error.code === 'MODULE_NOT_FOUND' ||
    String(error.message || '').includes(runtimePath)
  );
  if (!isMissingRuntime) throw error;
  module.exports = require('./sigma-analyzer.legacy.js');
}
