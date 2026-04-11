'use strict';

const path = require('path');
const runtimePath = path.resolve(__dirname, '../../../dist/ts-runtime/bots/reservation/lib/kiosk-slot-runner-service.js');

try {
  module.exports = require(runtimePath);
} catch {
  module.exports = require('./kiosk-slot-runner-service.legacy.js');
}
