#!/usr/bin/env node
// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as db from '../shared/db.ts';
import { recordEvidence } from '../shared/external-evidence-ledger.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  EDUX_POST_SHADOW_SOURCE_TYPE,
  buildEduxPostEvidenceRecords,
  fingerprintEduxPost,
  summarizeEduxEvidenceRecords,
} from '../shared/luna-edux-post-evidence.ts';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname);
const EDUX_DRY_RUN_DIR = path.join(ROOT, 'bots', 'edu-x', 'output', 'dry-run');
const OUT = path.resolve(new URL('../output/luna-edux-post-evidence-bridge.json', import.meta.url).pathname);

let pgPool = null;
try {
  pgPool = require('../../../packages/core/lib/pg-pool');
} catch {
  pgPool = null;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    json: false,
    dryRun: true,
    write: false,
    fixture: false,
    noWrite: false,
    limit: 25,
    lookbackHours: 48,
    source: 'all',
    includeTestPosts: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--json') args.json = true;
    else if (item === '--dry-run') args.dryRun = true;
    else if (item === '--write') { args.write = true; args.dryRun = false; }
    else if (item === '--fixture') args.fixture = true;
    else if (item === '--no-write') args.noWrite = true;
    else if (item === '--include-test-posts') args.includeTestPosts = true;
    else if (item === '--limit' && argv[i + 1]) args.limit = Number(argv[++i]);
    else if (item.startsWith('--limit=')) args.limit = Number(item.split('=', 2)[1]);
    else if (item === '--lookback-hours' && argv[i + 1]) args.lookbackHours = Number(argv[++i]);
    else if (item.startsWith('--lookback-hours=')) args.lookbackHours = Number(item.split('=', 2)[1]);
    else if (item === '--source' && argv[i + 1]) args.source = String(argv[++i]);
    else if (item.startsWith('--source=')) args.source = String(item.split('=', 2)[1]);
  }
  args.limit = Math.max(1, Math.min(200, Number(args.limit || 25)));
  args.lookbackHours = Math.max(1, Math.min(24 * 14, Number(args.lookbackHours || 48)));
  if (!['all', 'db', 'artifacts'].includes(args.source)) args.source = 'all';
  if (args.fixture) args.dryRun = true;
  return args;
}

function isTestPost(post = {}) {
  const title = String(post.title || '').trim();
  const metadata = post.metadata || {};
  const liveGate = metadata.liveGate || {};
  return /^\[TEST\]/i.test(title)
    || metadata.excludeFromLunaEvidence === true
    || metadata.oneOffLiveTest === true
    || liveGate.mode === 'one_off_live_test'
    || liveGate.testPost === true
    || metadata.testOnly === true
    || metadata.testPost === true
    || metadata.fixture === true;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function loadFixturePosts(now = new Date().toISOString()) {
  return [
    {
      id: 'fixture-crypto-btc',
      category: 'crypto',
      slot: '0600',
      status: 'dry_run',
      dryRun: true,
      title: '05/20 BTC/USDT 시황 카드 | $106,500 +1.8%',
      content: [
        '# 05/20 BTC/USDT 시황 카드 | $106,500 +1.8%',
        '',
        '⚡ 핵심 3줄',
        '- BTC/USDT는 $104,200 지지와 $108,900 저항 사이의 결정 구간입니다.',
        '- 상승 쪽은 $108,900 회복, 하락 쪽은 $104,200 이탈 여부가 핵심입니다.',
        '',
        '🤖 인공지능 추천안',
        '- 우선 관찰: BTC/USDT가 $104,200 위에서 버티는지 확인합니다.',
      ].join('\n'),
      generatedAt: now,
    },
    {
      id: 'fixture-kis-marketwide',
      category: 'kis',
      slot: '0900',
      status: 'dry_run',
      dryRun: true,
      title: '05/20 국내주식 시황 카드 | 코스피 2,920 +0.7%',
      content: '⚡ 핵심 3줄\n- 코스피 2,920pt, 외국인 수급과 반도체 거래대금을 우선 확인합니다.\n\n🤖 인공지능 추천안\n- 장초반 추격보다 수급 확인을 우선합니다.',
      generatedAt: now,
    },
    {
      id: 'fixture-overseas-marketwide',
      category: 'overseas',
      slot: '2200',
      status: 'dry_run',
      dryRun: true,
      title: '05/20 해외주식 시황 카드 | S&P500 6,250 +0.5%',
      content: '⚡ 핵심 3줄\n- NVDA와 Nasdaq 동조를 먼저 확인합니다.\n\n🤖 인공지능 추천안\n- VIX와 DXY가 안정될 때만 성장주 위험 선호를 높게 봅니다.',
      generatedAt: now,
    },
  ];
}

function loadArtifactPosts({ limit = 25, lookbackHours = 48 } = {}) {
  if (!fs.existsSync(EDUX_DRY_RUN_DIR)) return [];
  const cutoff = Date.now() - lookbackHours * 36e5;
  return fs.readdirSync(EDUX_DRY_RUN_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const file = path.join(EDUX_DRY_RUN_DIR, name);
      const stat = fs.statSync(file);
      return { file, name, mtimeMs: stat.mtimeMs };
    })
    .filter((item) => item.mtimeMs >= cutoff)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((item) => {
      const meta = readJson(item.file) || {};
      const stem = item.name.replace(/\.json$/, '');
      const content = readText(path.join(EDUX_DRY_RUN_DIR, `${stem}.md`));
      return {
        id: `artifact:${stem}`,
        category: meta.category,
        slot: meta.slot,
        status: meta.dryRun ? 'dry_run' : 'artifact',
        dryRun: meta.dryRun !== false,
        title: meta.title,
        content,
        generatedAt: meta.generatedAt || new Date(item.mtimeMs).toISOString(),
        metadata: meta.metadata || {},
      };
    })
    .filter((post) => post.category && post.title);
}

async function queryPublic(sql, params = []) {
  if (!pgPool) return [];
  return pgPool.query('public', sql, params).catch(() => []);
}

async function loadDbPosts({ limit = 25, lookbackHours = 48 } = {}) {
  const table = await queryPublic(`SELECT to_regclass('public.edux_publish_log') AS table_name`);
  if (table?.[0]?.table_name !== 'edux_publish_log') return [];
  const rows = await queryPublic(`
    SELECT id, category, schedule_slot, post_id, post_url, title, content_hash,
           status, published_at, created_at, metadata
      FROM edux_publish_log
     WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
       AND status IN ('success', 'dry_run')
     ORDER BY created_at DESC
     LIMIT $2
  `, [lookbackHours, limit]);
  return (rows || []).map((row) => ({
    id: row.id,
    category: row.category,
    slot: row.schedule_slot,
    postId: row.post_id,
    postUrl: row.post_url,
    title: row.title,
    content: row.metadata?.lunaEvidenceContentPreview || row.metadata?.lunaEvidenceSummary || '',
    contentHash: row.content_hash,
    status: row.status,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    metadata: row.metadata || {},
  })).filter((post) => post.category && post.title);
}

function mergePosts(posts = []) {
  const map = new Map();
  for (const post of posts) {
    const key = fingerprintEduxPost(post);
    const previous = map.get(key);
    if (!previous || String(post.content || '').length > String(previous.content || '').length) {
      map.set(key, post);
    }
  }
  return [...map.values()];
}

async function evidenceExists(fingerprint, symbol = null) {
  const row = await db.get(
    `SELECT id
       FROM external_evidence_events
      WHERE source_type = $1
        AND raw_ref->>'eduxFingerprint' = $2
        AND COALESCE(symbol, '') = COALESCE($3, '')
      LIMIT 1`,
    [EDUX_POST_SHADOW_SOURCE_TYPE, fingerprint, symbol || null],
  ).catch(() => null);
  return row?.id || null;
}

async function insertShadowEvidence(records = []) {
  await db.initSchema();
  const inserted = [];
  const duplicates = [];
  for (const record of records) {
    const fingerprint = record.rawRef?.eduxFingerprint;
    const existing = await evidenceExists(fingerprint, record.symbol);
    if (existing) {
      duplicates.push({ id: existing, fingerprint, symbol: record.symbol || null });
      continue;
    }
    const id = await recordEvidence(record);
    if (id) inserted.push({ id, fingerprint, symbol: record.symbol || null, market: record.market });
  }
  return { inserted, duplicates };
}

export async function runLunaEduxPostEvidenceBridge(options = {}) {
  const args = {
    ...parseArgs([]),
    ...options,
  };
  if (args.write === true && options.dryRun == null) args.dryRun = false;
  if (args.fixture) args.dryRun = true;
  const startedAt = new Date().toISOString();
  const sources = [];
  let posts = [];

  if (args.fixture) {
    posts = loadFixturePosts(startedAt);
    sources.push('fixture');
  } else {
    if (args.source === 'all' || args.source === 'db') {
      const dbPosts = await loadDbPosts(args);
      posts.push(...dbPosts);
      sources.push(`db:${dbPosts.length}`);
    }
    if (args.source === 'all' || args.source === 'artifacts') {
      const artifactPosts = loadArtifactPosts(args);
      posts.push(...artifactPosts);
      sources.push(`artifacts:${artifactPosts.length}`);
    }
  }

  posts = mergePosts(posts)
    .filter((post) => args.includeTestPosts || !isTestPost(post))
    .slice(0, args.limit);
  const records = buildEduxPostEvidenceRecords(posts, { now: startedAt });
  const summary = summarizeEduxEvidenceRecords(records);
  const canWriteEvidence = args.write === true && args.dryRun !== true;
  const writeResult = canWriteEvidence ? await insertShadowEvidence(records) : { inserted: [], duplicates: [] };

  const payload = {
    ok: true,
    status: canWriteEvidence ? 'edux_shadow_evidence_recorded' : 'edux_shadow_evidence_planned',
    generatedAt: startedAt,
    dryRun: !canWriteEvidence,
    writeRequested: args.write === true,
    source: args.source,
    sources,
    lookbackHours: args.lookbackHours,
    includeTestPosts: args.includeTestPosts,
    postsRead: posts.length,
    evidencePlanned: records.length,
    evidenceInserted: writeResult.inserted.length,
    duplicateSkipped: writeResult.duplicates.length,
    summary,
    safety: {
      shadowOnly: true,
      liveMutation: false,
      tradingDecisionPriorityChanged: false,
      liveBuySellPathTouched: false,
      protectedPidTouched: false,
    },
    sample: records.slice(0, 5).map((record) => ({
      sourceType: record.sourceType,
      symbol: record.symbol,
      market: record.market,
      signalDirection: record.signalDirection,
      score: record.score,
      sourceQuality: record.sourceQuality,
      freshnessScore: record.freshnessScore,
      evidenceSummary: record.evidenceSummary,
      rawRef: record.rawRef,
    })),
  };

  if (!args.noWrite) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  return payload;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: () => runLunaEduxPostEvidenceBridge(parseArgs()),
    onSuccess: async (result) => {
      if (parseArgs().json) console.log(JSON.stringify(result, null, 2));
      else console.log(`[luna-edux-post-evidence-bridge] status=${result.status} planned=${result.evidencePlanned} inserted=${result.evidenceInserted}`);
    },
    errorPrefix: 'luna-edux-post-evidence-bridge error:',
  });
}
