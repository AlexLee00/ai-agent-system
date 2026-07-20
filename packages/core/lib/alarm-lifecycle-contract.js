'use strict';

const { loadTsSourceBridge } = require('./ts-source-bridge.js');

module.exports = loadTsSourceBridge(__dirname, 'alarm-lifecycle-contract');
module.exports.default = module.exports;
