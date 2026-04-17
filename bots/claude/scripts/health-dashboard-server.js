'use strict';

const { loadTsSourceBridge } = require('../lib/ts-source-bridge.js');

module.exports = loadTsSourceBridge(__dirname, 'health-dashboard-server');
module.exports.default = module.exports;
