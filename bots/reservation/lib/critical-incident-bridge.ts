'use strict';

const { loadCoreRuntimeModule } = require('./core-runtime-bridge');
const criticalIncident = loadCoreRuntimeModule('critical-incident');

module.exports = criticalIncident;
