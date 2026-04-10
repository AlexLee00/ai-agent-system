// @ts-nocheck

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const SHARED_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_DIR = path.resolve(SHARED_DIR, '..', 'scripts');
const VECTORBT_SCRIPT = path.join(SCRIPT_DIR, 'backtest-vectorbt.py');

function runVectorBtCommand(args = []) {
  try {
    const raw = execFileSync(
      'python3',
      [VECTORBT_SCRIPT, ...args, '--json'],
      {
        cwd: SCRIPT_DIR,
        encoding: 'utf8',
        timeout: 600_000,
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
    throw error;
  }
}

export function runVectorBtBacktest(symbol, days, { tpPct, slPct } = {}) {
  const args = ['--symbol', symbol, '--days', String(days)];
  if (tpPct != null) args.push('--tp', String(tpPct));
  if (slPct != null) args.push('--sl', String(slPct));
  return runVectorBtCommand(args);
}

export function runVectorBtGrid(symbol, days) {
  return runVectorBtCommand(['--symbol', symbol, '--days', String(days), '--grid']);
}

export function getVectorBtScriptPath() {
  return VECTORBT_SCRIPT;
}
