'use strict';

const { loadTsSourceBridge } = require('./ts-source-bridge.js');

module.exports = loadTsSourceBridge(__dirname, 'github-client');
module.exports.default = module.exports;
