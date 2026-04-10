const fs = require('fs');
const path = require('path');
const { createRuntimeConfigLoader } = require('../../../packages/core/lib/runtime-config-loader');

const DEFAULT_RUNTIME_CONFIG = {
  browser: {
    launchRetries: 3,
    launchRetryDelayMs: 2000,
    navigationTimeoutMs: 30000,
    pickkoProtocolTimeoutMs: 180000,
  },
  naverMonitor: {
    maxRetries: 5,
    errorTrackerThreshold: 3,
    staleConfirmCount: 5,
    staleMinElapsedMs: 10 * 60 * 1000,
    staleExpireMs: 30 * 60 * 1000,
    verifyBeforeUnresolvedReport: true,
    verifyBeforeUnresolvedReportTimeoutMs: 4 * 60 * 1000,
  },
  kioskMonitor: {
    errorTrackerThreshold: 3,
    customerOperationCooldownMs: 30000,
  },
};

const { loadRuntimeConfig } = createRuntimeConfigLoader({
  fs,
  defaults: DEFAULT_RUNTIME_CONFIG,
  configPath: path.join(__dirname, '..', 'config.yaml'),
  format: 'yaml',
});

function getReservationRuntimeConfig() {
  return loadRuntimeConfig();
}

function getReservationBrowserConfig() {
  return loadRuntimeConfig().browser;
}

function getReservationNaverMonitorConfig() {
  return loadRuntimeConfig().naverMonitor;
}

function getReservationKioskMonitorConfig() {
  return loadRuntimeConfig().kioskMonitor;
}

module.exports = {
  getReservationRuntimeConfig,
  getReservationBrowserConfig,
  getReservationNaverMonitorConfig,
  getReservationKioskMonitorConfig,
};
