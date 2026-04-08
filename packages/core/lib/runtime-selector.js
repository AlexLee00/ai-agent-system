'use strict';

const path = require('path');

const distPath = path.join(__dirname, '../../../dist/ts-runtime/packages/core/lib/runtime-selector.js');

try {
  module.exports = require(distPath);
} catch {
  module.exports = require('./runtime-selector.legacy.js');
}
