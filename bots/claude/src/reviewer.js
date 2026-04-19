'use strict';

const path = require('node:path');
const { loadTsSourceBridge } = require('../lib/ts-source-bridge.js');

module.exports = loadTsSourceBridge(__dirname, 'reviewer');
module.exports.default = module.exports;
