'use strict';

const { loadTsSourceBridge } = require('./ts-source-bridge.js');

module.exports = loadTsSourceBridge(__dirname, 'service-ownership');
module.exports.default = module.exports;
