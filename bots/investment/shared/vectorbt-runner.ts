// @ts-nocheck

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const SHARED_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = path.resolve(SHARED_DIR, '..', 'scripts');
const VECTORBT_SCRIPT = path.join(SCRIPT_DIR, 'backtest-vectorbt.py');
const DEFAULT_VECTORBT_TIMEOUT_MS = Math.max(5_000, Number(process.env.LUNA_VECTORBT_TIMEOUT_MS || 90_000));
const PBO_TIMEOUT_MS = Math.max(30_000, Number(process.env.LUNA_PBO_TIMEOUT_MS || 90_000));
const META_LABEL_TIMEOUT_MS = Math.max(30_000, Number(process.env.LUNA_META_LABEL_TIMEOUT_MS || 60_000));

function runVectorBtCommand(args = [], options = {}) {
  const timeoutMs = Math.max(5_000, Number(options.timeoutMs || DEFAULT_VECTORBT_TIMEOUT_MS));
  const env = options.env ? { ...process.env, ...options.env } : process.env;
  try {
    const raw = execFileSync(
      'python3',
      [VECTORBT_SCRIPT, ...args, '--json'],
      {
        cwd: SCRIPT_DIR,
        encoding: 'utf8',
        timeout: timeoutMs,
        env,
      },
    );
    return JSON.parse(raw);
  } catch (error) {
    const stdout = error?.stdout?.toString?.() || '';
    if (stdout) {
      try {
        return JSON.parse(stdout);
      } catch {
        // fall through
      }
    }
    const timedOut = error?.signal === 'SIGTERM'
      || error?.code === 'ETIMEDOUT'
      || /timed out|timeout|SIGTERM/i.test(String(error?.message || ''));
    if (timedOut) {
      return {
        status: 'timeout',
        message: `vectorbt_timeout(${timeoutMs}ms)`,
        timeoutMs,
        args,
      };
    }
    return {
      status: 'error',
      message: String(error?.message || error),
      args,
    };
  }
}

function appendUniverseMetadataArgs(args = [], options = {}) {
  if (options.universeAsOf != null && String(options.universeAsOf).trim()) {
    args.push('--universe-asof', String(options.universeAsOf));
  }
  if (options.universeSource != null && String(options.universeSource).trim()) {
    args.push('--universe-source', String(options.universeSource));
  }
  return args;
}

export function runVectorBtBacktest(symbol, days, { tpPct, slPct, timeoutMs, universeAsOf, universeSource } = {}) {
  const args = ['--symbol', symbol, '--days', String(days)];
  if (tpPct != null) args.push('--tp', String(tpPct));
  if (slPct != null) args.push('--sl', String(slPct));
  appendUniverseMetadataArgs(args, { universeAsOf, universeSource });
  return runVectorBtCommand(args, { timeoutMs });
}

export function runVectorBtGrid(symbol, days, options = {}) {
  const args = appendUniverseMetadataArgs(['--symbol', symbol, '--days', String(days), '--grid'], options);
  return runVectorBtCommand(args, options);
}

export function runVectorBtPbo(symbol, days, options = {}) {
  const opts = { timeoutMs: PBO_TIMEOUT_MS, ...options };
  const args = appendUniverseMetadataArgs(['--symbol', symbol, '--days', String(days), '--grid', '--pbo'], opts);
  return runVectorBtCommand(args, opts);
}

export function runVectorBtMetaLabels(symbol, days, options = {}) {
  const opts = { timeoutMs: META_LABEL_TIMEOUT_MS, ...options };
  const args = appendUniverseMetadataArgs(['--symbol', symbol, '--days', String(days), '--grid', '--meta-labels'], opts);
  return runVectorBtCommand(args, opts);
}

export function getVectorBtScriptPath() {
  return VECTORBT_SCRIPT;
}

export const __test = {
  appendUniverseMetadataArgs,
};
