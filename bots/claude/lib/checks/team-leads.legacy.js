'use strict';

const { loadTsSourceBridge } = require('../ts-source-bridge.js');

module.exports = loadTsSourceBridge(__dirname, 'team-leads');
module.exports.default = module.exports;
