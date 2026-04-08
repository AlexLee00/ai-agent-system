'use strict';
const path = require('path');

const distPath = path.join(__dirname, '../../../dist/ts-runtime/packages/core/lib/hub-client.js');

try {
  module.exports = require(distPath);
} catch {
  module.exports = require('./hub-client.legacy.js');
}
