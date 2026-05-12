'use strict';

const { loadTsSourceBridge } = require('./ts-source-bridge.js');

module.exports = loadTsSourceBridge(__dirname, 'telegram-sender');
module.exports.default = module.exports;
