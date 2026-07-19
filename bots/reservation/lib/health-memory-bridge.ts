'use strict';

const { loadCoreRuntimeModule } = require('./core-runtime-bridge');
const healthMemory = loadCoreRuntimeModule('health-memory');

module.exports = healthMemory;
