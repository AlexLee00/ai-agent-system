'use strict';

const path = require('path');

const distPath = path.join(__dirname, '../../../dist/ts-runtime/packages/core/lib/trace-collector.js');

try {
  module.exports = require(distPath);
} catch {
  module.exports = require('./trace-collector.legacy.js');
}
