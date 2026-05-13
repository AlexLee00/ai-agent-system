'use strict';

const { loadTsSourceBridge } = require('./ts-source-bridge.js');

module.exports = loadTsSourceBridge(__dirname, 'cycle');
module.exports.default = module.exports;
