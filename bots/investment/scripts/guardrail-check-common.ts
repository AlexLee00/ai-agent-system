#!/usr/bin/env node
// @ts-nocheck

import { spawn } from 'node:child_process';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export function wantsJson() {
  return process.argv.includes('--json');
}

export function buildGuardrailResult({
  name,
  ok = true,
  status = null,
  severity = 'medium',
  owner = 'luna',
  blockers = [],
  warnings = [],
  evidence = {},
} = {}) {
  return {
    ok: Boolean(ok) && blockers.length === 0,
    name,
    status: status || (blockers.length > 0 ? 'blocked' : warnings.length > 0 ? 'attention' : 'ok'),
    severity,
    owner,
    blockers,
    warnings,
    evidence,
    checkedAt: new Date().toISOString(),
  };
}

export function printGuardrailResult(result) {
  if (wantsJson()) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${result.name} ${result.status} ok=${result.ok}\n`);
}

export function defineGuardrailCli(importMetaUrl, { name, run, errorPrefix = null }) {
  async function main() {
    const originalLog = console.log;
    const originalInfo = console.info;
    if (wantsJson()) {
      console.log = (...args) => { process.stderr.write(`${args.join(' ')}\n`); };
      console.info = (...args) => { process.stderr.write(`${args.join(' ')}\n`); };
    }
    const result = await run();
    console.log = originalLog;
    console.info = originalInfo;
    printGuardrailResult(result);
    if (result.ok !== true) throw new Error(`${name}:${result.status}`);
  }
  if (isDirectExecution(importMetaUrl)) {
    void runCliMain({
      run: main,
      errorPrefix: errorPrefix || `❌ ${name} 실패:`,
    });
  }
}

export function runProcess(command, args = [], { cwd = process.cwd(), timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, exitCode: null, stdout, stderr: `${stderr}\nTIMEOUT ${timeoutMs}ms`.trim() });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, exitCode: code, stdout, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, stdout, stderr: String(error?.message || error) });
    });
  });
}

export async function fetchJson(url, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: null, error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}
