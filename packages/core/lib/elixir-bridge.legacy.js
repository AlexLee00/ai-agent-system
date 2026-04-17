'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { createMessage } = require('./message-envelope');

let _bridgeModulePromise = null;

function _getBridgeModulePath() {
  return path.resolve(__dirname, '../../../dist/ts-phase1/packages/core/lib/elixir-bridge.js');
}

async function _loadBridgeModule() {
  if (!_bridgeModulePromise) {
    _bridgeModulePromise = import(pathToFileURL(_getBridgeModulePath()).href);
  }
  return _bridgeModulePromise;
}

async function encodeBridgePayload(payload) {
  const mod = await _loadBridgeModule();
  return mod.encodeBridgePayload(payload);
}

async function decodeBridgePayload(serialized) {
  const mod = await _loadBridgeModule();
  return mod.decodeBridgePayload(serialized);
}

async function createOrchestrationBridgePayload({
  fromBot = 'luna',
  toBot = 'elixir',
  market,
  symbol = null,
  stage,
  sessionId = null,
  regime = null,
  severity = 'info',
} = {}) {
  const envelope = createMessage('status_update', fromBot, toBot, {
    bridge: 'luna_orchestrate',
    market,
    symbol,
    stage,
  }, {
    run_id: sessionId,
    task_id: symbol,
    correlation_id: stage || null,
    priority: severity === 'error' ? 'high' : 'normal',
  });

  const event = {
    eventType: 'luna_orchestrate',
    team: 'luna',
    botName: fromBot,
    severity,
    traceId: sessionId || undefined,
    title: `${fromBot}:${stage || 'unknown'}`,
    message: [market || 'unknown', symbol || 'all', stage || 'unknown'].join(':'),
    tags: [
      'bridge:luna_orchestrate',
      market ? `market:${market}` : null,
      symbol ? `symbol:${symbol}` : null,
      stage ? `stage:${stage}` : null,
    ].filter(Boolean),
    metadata: {
      market,
      symbol,
      stage,
      sessionId,
    },
  };

  const payload = regime ? { envelope, event, regime } : { envelope, event };
  return {
    payload,
    serialized: await encodeBridgePayload(payload),
  };
}

module.exports = {
  encodeBridgePayload,
  decodeBridgePayload,
  createOrchestrationBridgePayload,
};
