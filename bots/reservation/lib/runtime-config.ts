import fs from 'fs';
import path from 'path';
import { createRuntimeConfigLoader } from '../../../packages/core/lib/runtime-config-loader';

interface ReservationRuntimeConfig {
  browser: {
    launchRetries: number;
    launchRetryDelayMs: number;
    navigationTimeoutMs: number;
    pickkoProtocolTimeoutMs: number;
  };
  naverMonitor: {
    maxRetries: number;
    errorTrackerThreshold: number;
    staleConfirmCount: number;
    staleMinElapsedMs: number;
    staleExpireMs: number;
    verifyBeforeUnresolvedReport: boolean;
    verifyBeforeUnresolvedReportTimeoutMs: number;
  };
  kioskMonitor: {
    errorTrackerThreshold: number;
    customerOperationCooldownMs: number;
  };
}

const DEFAULT_RUNTIME_CONFIG: ReservationRuntimeConfig = {
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

type RuntimeConfigLoaderResult = {
  loadRuntimeConfig: () => ReservationRuntimeConfig;
};

const { loadRuntimeConfig } = createRuntimeConfigLoader({
  fs: {
    readFileSync: (filePath: string, encoding: string) => fs.readFileSync(filePath, encoding as BufferEncoding),
  },
  defaults: DEFAULT_RUNTIME_CONFIG as unknown as Record<string, unknown>,
  configPath: path.join(__dirname, '..', 'config.yaml'),
  format: 'yaml',
}) as unknown as RuntimeConfigLoaderResult;

export function getReservationRuntimeConfig(): ReservationRuntimeConfig {
  return loadRuntimeConfig();
}

export function getReservationBrowserConfig(): ReservationRuntimeConfig['browser'] {
  return loadRuntimeConfig().browser;
}

export function getReservationNaverMonitorConfig(): ReservationRuntimeConfig['naverMonitor'] {
  return loadRuntimeConfig().naverMonitor;
}

export function getReservationKioskMonitorConfig(): ReservationRuntimeConfig['kioskMonitor'] {
  return loadRuntimeConfig().kioskMonitor;
}
