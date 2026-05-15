// @ts-nocheck

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const SHARED_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = path.resolve(SHARED_DIR, '..', 'scripts');
const VECTORBT_SCRIPT = path.join(SCRIPT_DIR, 'backtest-vectorbt.py');
const DEFAULT_VECTORBT_TIMEOUT_MS = Math.max(5_000, Number(process.env.LUNA_VECTORBT_TIMEOUT_MS || 30_000));

function runVectorBtCommand(args = [], options = {}) {
  const timeoutMs = Math.max(5_000, Number(options.timeoutMs || DEFAULT_VECTORBT_TIMEOUT_MS));
  try {
    const raw = execFileSync(
      'python3',
      [VECTORBT_SCRIPT, ...args, '--json'],
      {
        cwd: SCRIPT_DIR,
        encoding: 'utf8',
        timeout: timeoutMs,
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

export function runVectorBtBacktest(symbol, days, { tpPct, slPct, timeoutMs } = {}) {
  const args = ['--symbol', symbol, '--days', String(days)];
  if (tpPct != null) args.push('--tp', String(tpPct));
  if (slPct != null) args.push('--sl', String(slPct));
  return runVectorBtCommand(args, { timeoutMs });
}

export function runVectorBtGrid(symbol, days, options = {}) {
  return runVectorBtCommand(['--symbol', symbol, '--days', String(days), '--grid'], options);
}

export function getVectorBtScriptPath() {
  return VECTORBT_SCRIPT;
}
