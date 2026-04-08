'use strict';
const path = require('path');

const distPath = path.join(__dirname, '../../../dist/ts-runtime/packages/core/lib/llm-model-selector.js');

try {
  module.exports = require(distPath);
} catch {
  module.exports = require('./llm-model-selector.legacy.js');
}
