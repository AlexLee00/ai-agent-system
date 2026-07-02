'use strict';

const { loadTsSourceBridge } = require('./ts-source-bridge.js');

module.exports = loadTsSourceBridge(__dirname, 'agent-llm-routing-adapter');
module.exports.default = module.exports;
