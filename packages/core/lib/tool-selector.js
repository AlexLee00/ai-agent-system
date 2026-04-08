'use strict';

const path = require('path');

const distPath = path.join(__dirname, '../../../dist/ts-runtime/packages/core/lib/tool-selector.js');

try {
  module.exports = require(distPath);
} catch {
  module.exports = require('./tool-selector.legacy.js');
}
