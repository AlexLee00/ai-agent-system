// @ts-nocheck

import os from 'node:os';
import path from 'node:path';

export const INVESTMENT_REPO_ROOT = '/Users/alexlee/projects/ai-agent-system/bots/investment';
export const LEGACY_INVESTMENT_OPS_DIR = path.join(INVESTMENT_REPO_ROOT, 'output', 'ops');
export const DEFAULT_INVESTMENT_OPS_RUNTIME_DIR = path.join(
  os.homedir(),
  '.ai-agent-system',
  'investment',
  'ops',
);

export function getInvestmentOpsRuntimeDir() {
  return process.env.INVESTMENT_OPS_RUNTIME_DIR || DEFAULT_INVESTMENT_OPS_RUNTIME_DIR;
}

export function investmentOpsRuntimeFile(filename) {
  return path.join(getInvestmentOpsRuntimeDir(), filename);
}

export function investmentOpsLegacyFile(filename) {
  return path.join(LEGACY_INVESTMENT_OPS_DIR, filename);
}
