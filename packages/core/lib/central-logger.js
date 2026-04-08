'use strict';
const path = require('path');

const distPath = path.join(__dirname, '../../../dist/ts-runtime/packages/core/lib/central-logger.js');

try {
  module.exports = require(distPath);
} catch {
  module.exports = require('./central-logger.legacy.js');
}
