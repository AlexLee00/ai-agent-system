'use strict';

const path = require('path');

const distPath = path.join(__dirname, '../../../dist/ts-runtime/packages/core/lib/llm-keys.js');

try {
  module.exports = require(distPath);
} catch {
  module.exports = require('./llm-keys.legacy.js');
}
