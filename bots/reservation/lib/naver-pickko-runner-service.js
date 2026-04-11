'use strict';

const path = require('path');
const runtimePath = path.resolve(__dirname, '../../../dist/ts-runtime/bots/reservation/lib/naver-pickko-runner-service.js');

try {
  module.exports = require(runtimePath);
} catch {
  module.exports = require('./naver-pickko-runner-service.legacy.js');
}
