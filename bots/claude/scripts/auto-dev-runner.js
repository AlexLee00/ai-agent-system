'use strict';

const { loadTsSourceBridge } = require('../lib/ts-source-bridge.js');

module.exports = loadTsSourceBridge(__dirname, 'auto-dev-runner');
module.exports.default = module.exports;
