'use strict';

const path = require('path');

const distPath = path.join(__dirname, '../../../dist/ts-runtime/packages/core/lib/token-tracker.js');

try {
  module.exports = require(distPath);
} catch {
  module.exports = require('./token-tracker.legacy.js');
}
