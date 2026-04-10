'use client';

import workerConfig from '../../config.json';

const defaults = {
  authRequestTimeoutMs: 5000,
  authReleaseBufferMs: 1500,
  wsReconnectDelayMs: 2000,
};

function readWebRuntimeConfig() {
  return workerConfig?.runtime_config?.web || {};
}

export function getWorkerWebRuntimeConfig() {
  return {
    ...defaults,
    ...readWebRuntimeConfig(),
  };
}
