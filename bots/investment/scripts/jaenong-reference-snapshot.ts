#!/usr/bin/env node
// @ts-nocheck

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as db from '../shared/db.ts';
import {
  buildJaenongReferenceSnapshot,
  resolveJaenongReferenceDirectory,
} from '../shared/jaenong-operations.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const EXTRACTOR_PATH = fileURLToPath(new URL('./jaenong-reference-xlsx-extract.py', import.meta.url));
export const JAENONG_REFERENCE_WRITE_CONFIRM = 'jaenong-reference-snapshot-shadow';

function latestXlsx(directory) {
  if (!fs.existsSync(directory)) return null;
  return fs.readdirSync(directory)
    .filter((file) => file.toLowerCase().endsWith('.xlsx'))
    .map((file) => ({ file, mtimeMs: fs.statSync(path.join(directory, file)).mtimeMs }))
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs || left.file.localeCompare(right.file))[0]?.file || null;
}

function sourcePathFromOptions(options = {}) {
  if (options.sourcePath) return path.resolve(options.sourcePath);
  const directory = resolveJaenongReferenceDirectory({ env: options.env, c17: options.c17 });
  const file = latestXlsx(directory);
  if (!file) throw new Error(`jaenong_reference_xlsx_missing:${directory}`);
  return path.join(directory, file);
}

export function extractJaenongWorkbook(sourcePath, deps = {}) {
  const run = deps.execFileSync || execFileSync;
  const output = run('python3', [EXTRACTOR_PATH, sourcePath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(output);
}

async function defaultQuoteProvider(symbol) {
  const { getOverseasPrice } = await import('../shared/kis-client.ts');
  const quote = await getOverseasPrice(symbol);
  return quote?.price ?? null;
}

async function latestStoredHash(queryFn) {
  const rows = await queryFn(
    `SELECT snapshot_hash
       FROM investment.jaenong_reference_snapshot
      ORDER BY captured_at DESC, id DESC
      LIMIT 1`,
    [],
  );
  return String(rows?.[0]?.snapshot_hash || '').trim().toLowerCase() || null;
}

async function persistSnapshot(snapshot, runFn) {
  const result = await runFn(
    `INSERT INTO investment.jaenong_reference_snapshot
       (snapshot_hash, revision, source_file_name, source_modified_at, parser_version,
        timing, barometer, interest, c17_proposal, quote_fallbacks, parse_status, shadow_only)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
             $10::jsonb, 'parsed', true)
     ON CONFLICT (snapshot_hash) DO NOTHING`,
    [
      snapshot.snapshotHash,
      snapshot.revision,
      snapshot.sourceFileName,
      snapshot.sourceModifiedAt,
      snapshot.parserVersion,
      JSON.stringify(snapshot.timing),
      JSON.stringify(snapshot.barometer),
      JSON.stringify(snapshot.interest),
      JSON.stringify(snapshot.c17Proposal),
      JSON.stringify(snapshot.quoteFallbacks),
    ],
  );
  return Number(result?.rowCount || 0) > 0;
}

export async function runJaenongReferenceSnapshot(options = {}, deps = {}) {
  if (options.write === true && options.confirm !== JAENONG_REFERENCE_WRITE_CONFIRM) {
    throw new Error('jaenong_reference_write_confirmation_required');
  }
  const sourcePath = sourcePathFromOptions(options);
  const stats = fs.statSync(sourcePath);
  if (!stats.isFile()) throw new Error('jaenong_reference_source_not_file');
  const bytes = fs.readFileSync(sourcePath);
  const snapshotHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const workbook = extractJaenongWorkbook(sourcePath, deps);
  const snapshot = await buildJaenongReferenceSnapshot(workbook, {
    sourceFileName: path.basename(sourcePath),
    sourceModifiedAt: stats.mtime.toISOString(),
    snapshotHash,
    quoteProvider: deps.quoteProvider || defaultQuoteProvider,
  });

  const queryFn = deps.queryFn || db.query;
  const previousHash = options.previousHash === undefined
    ? await latestStoredHash(queryFn).catch(() => null)
    : String(options.previousHash || '').toLowerCase() || null;
  const changed = snapshotHash !== previousHash;
  let persisted = false;
  if (options.write === true) {
    persisted = await persistSnapshot(snapshot, deps.runFn || db.run);
  }

  return {
    ok: true,
    mode: options.write === true ? 'shadow_write' : 'dry_run',
    sourcePath,
    changed,
    previousHash,
    persisted,
    snapshot,
    safety: {
      rawWorkbookPersisted: false,
      c17AutoApply: false,
      liveTradeConnected: false,
      writeRequiresConfirmation: true,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  const argv = process.argv.slice(2);
  const value = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) || null;
  void runCliMain({
    run: () => runJaenongReferenceSnapshot({
      sourcePath: value('source'),
      write: argv.includes('--write'),
      confirm: value('confirm'),
    }),
    onSuccess: (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: 'jaenong reference snapshot failed:',
  });
}
