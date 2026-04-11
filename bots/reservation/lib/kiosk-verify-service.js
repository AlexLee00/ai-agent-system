'use strict';

const path = require('path');
const runtimePath = path.resolve(__dirname, '../../../dist/ts-runtime/bots/reservation/lib/kiosk-verify-service.js');

try {
  module.exports = require(runtimePath);
} catch {
  module.exports = require('./kiosk-verify-service.legacy.js');
}
