// @ts-nocheck
'use strict';

/**
 * Retired compatibility module.
 *
 * Dexter no longer monitors or restarts the legacy gateway. Hub health, OAuth,
 * routing, and alarm delivery are checked through Hub-native probes instead.
 */

async function run() {
  return {
    name: 'Legacy gateway health',
    status: 'ok',
    items: [
      {
        label: 'legacy gateway',
        status: 'ok',
        detail: 'retired; Hub-native control plane is authoritative',
      },
    ],
  };
}

module.exports = { run };
