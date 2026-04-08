'use strict';
const path = require('path');

const distPath = path.join(__dirname, '../../../dist/ts-runtime/packages/core/lib/llm-fallback.js');

try {
  module.exports = require(distPath);
} catch {
  module.exports = require('./llm-fallback.legacy.js');
}
