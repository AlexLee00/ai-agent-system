'use strict';
const path = require('path');

const distPath = path.join(__dirname, '../../../dist/ts-runtime/packages/core/lib/env.js');

try {
  module.exports = require(distPath);
} catch {
  module.exports = require('./env.legacy.js');
}
