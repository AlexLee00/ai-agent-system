// @ts-nocheck

import os from 'node:os';
import path from 'node:path';
import {
  JAENONG_C17_DEFAULTS,
  JAENONG_C17_PARAMETER_KEYS,
  buildJaenongTranchePlan,
} from './market-regime.ts';

export const JAENONG_REFERENCE_PARSER_VERSION = 'jaenong-reference-v1';
export const JAENONG_REFERENCE_DIRECTORY_KEY = 'c17.jaenong.reference_directory';

function text(value) {
  return String(value ?? '').trim();
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cell(workbook, sheetName, address) {
  return workbook?.sheets?.[sheetName]?.cells?.[address] || { value: null, formula: null };
}

function cellValue(workbook, sheetName, address) {
  return cell(workbook, sheetName, address).value ?? null;
}

function table(workbook, rows) {
  return rows.map((row) => [
    finite(cellValue(workbook, '기준시트의 사본', `F${row}`)),
    finite(cellValue(workbook, '기준시트의 사본', `G${row}`)),
  ]).filter(([threshold, score]) => threshold != null && score != null);
}

function maxRow(workbook, sheetName, columns) {
  const addresses = Object.keys(workbook?.sheets?.[sheetName]?.cells || {});
  return addresses.reduce((max, address) => {
    const match = address.match(/^([A-Z]+)(\d+)$/);
    if (!match || !columns.includes(match[1])) return max;
    return Math.max(max, Number(match[2]));
  }, 0);
}

function drawdownZone(value, thresholds) {
  const drawdown = finite(value);
  if (drawdown == null) return 'unknown';
  const sorted = thresholds
    .filter(([threshold]) => threshold > -1)
    .toSorted((left, right) => left[0] - right[0]);
  if (sorted.length >= 3) {
    if (drawdown <= sorted[0][0]) return 'deep';
    if (drawdown <= sorted[1][0]) return 'pullback';
    if (drawdown <= sorted[2][0]) return 'watch';
  }
  return 'neutral';
}

async function cachedPriceOrQuote(workbook, sheetName, address, symbol, quoteProvider, fallbacks) {
  const source = cell(workbook, sheetName, address);
  const cached = finite(source.value);
  if (cached != null && cached > 0) return cached;
  if (!/GOOGLEFINANCE/i.test(text(source.formula)) || typeof quoteProvider !== 'function') return null;
  const quote = finite(await quoteProvider(symbol));
  if (quote == null || quote <= 0) return null;
  fallbacks.push({ sheet: sheetName, address, symbol, provider: 'kis' });
  return quote;
}

export function resolveJaenongReferenceDirectory({ env = process.env, c17 = {} } = {}) {
  const configured = text(env.JAENONG_REFERENCE_DIR) || text(c17[JAENONG_REFERENCE_DIRECTORY_KEY]);
  const expanded = configured.startsWith('~/')
    ? path.join(os.homedir(), configured.slice(2))
    : configured;
  return path.resolve(expanded || path.join(os.homedir(), '.ai-agent-system', 'investment', 'jaenong-reference'));
}

export function identifyJaenongRevision(fileName) {
  const match = text(fileName).match(/(?:^|[_-])(REV\d+(?:[_-]\d+)*)(?:[_-]|\.)/i);
  return match ? match[1].replaceAll('-', '_').toUpperCase() : 'REV_UNKNOWN';
}

export async function buildJaenongReferenceSnapshot(workbook, options = {}) {
  const snapshotHash = text(options.snapshotHash).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(snapshotHash)) throw new Error('jaenong_snapshot_hash_invalid');

  const sourceFileName = path.basename(text(options.sourceFileName));
  const sourceModifiedAt = new Date(options.sourceModifiedAt || 0);
  if (!sourceFileName) throw new Error('jaenong_source_file_name_required');
  if (!Number.isFinite(sourceModifiedAt.getTime())) throw new Error('jaenong_source_modified_at_invalid');

  const timing = {
    values: {
      spyDrawdownRatio: finite(cellValue(workbook, '판단부분', 'E3')),
      vix: finite(cellValue(workbook, '판단부분', 'E6')),
      fearGreed: finite(cellValue(workbook, '판단부분', 'E7')),
    },
    labels: {
      spy: text(cellValue(workbook, '판단부분', 'F3')) || null,
      vix: text(cellValue(workbook, '판단부분', 'F6')) || null,
      fearGreed: text(cellValue(workbook, '판단부분', 'F7')) || null,
    },
    formulas: {
      spy: text(cell(workbook, '판단부분', 'F3').formula) || null,
      vix: text(cell(workbook, '판단부분', 'F6').formula) || null,
      fearGreed: text(cell(workbook, '판단부분', 'F7').formula) || null,
    },
  };

  const fallbacks = [];
  const barometer = [];
  const seenBarometer = new Set();
  for (let row = 11; row <= maxRow(workbook, '판단부분', ['B', 'N']); row += 1) {
    const symbol = text(cellValue(workbook, '판단부분', `B${row}`)).toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) || seenBarometer.has(symbol)) continue;
    seenBarometer.add(symbol);
    barometer.push({
      symbol,
      currentPrice: await cachedPriceOrQuote(
        workbook,
        '판단부분',
        `C${row}`,
        symbol,
        options.quoteProvider,
        fallbacks,
      ),
      marketCapBillionUsd: finite(cellValue(workbook, '판단부분', `D${row}`)),
      drawdownRatio: finite(cellValue(workbook, '판단부분', `E${row}`)),
      ytdReturnRatio: finite(cellValue(workbook, '판단부분', `F${row}`)),
      forwardPer: finite(cellValue(workbook, '판단부분', `G${row}`)),
      forwardPerDeltaRatio: finite(cellValue(workbook, '판단부분', `H${row}`)),
      rsi: finite(cellValue(workbook, '판단부분', `I${row}`)),
      dma200DeltaRatio: finite(cellValue(workbook, '판단부분', `J${row}`)),
      debtToEquity: finite(cellValue(workbook, '판단부분', `K${row}`)),
      epsNextYearRatio: finite(cellValue(workbook, '판단부분', `L${row}`)),
      financialScore: finite(cellValue(workbook, '판단부분', `M${row}`)),
      judgement: text(cellValue(workbook, '판단부분', `N${row}`)) || null,
      sourceRow: row,
    });
  }

  const drawdownThresholds = table(workbook, [8, 9, 10, 11]);
  const interest = [];
  const seenInterest = new Set();
  let sector = null;
  for (let row = 5; row <= maxRow(workbook, '종목별 데이터', ['B', 'P']); row += 1) {
    sector = text(cellValue(workbook, '종목별 데이터', `B${row}`)) || sector;
    const symbol = text(cellValue(workbook, '종목별 데이터', `C${row}`)).toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) || seenInterest.has(symbol)) continue;
    seenInterest.add(symbol);
    const rowData = {
      sector,
      symbol,
      currentPrice: await cachedPriceOrQuote(
        workbook,
        '종목별 데이터',
        `D${row}`,
        symbol,
        options.quoteProvider,
        fallbacks,
      ),
      marketCapBillionUsd: finite(cellValue(workbook, '종목별 데이터', `E${row}`)),
      drawdownRatio: finite(cellValue(workbook, '종목별 데이터', `F${row}`)),
      ytdReturnRatio: finite(cellValue(workbook, '종목별 데이터', `G${row}`)),
      psr: finite(cellValue(workbook, '종목별 데이터', `H${row}`)),
      per: finite(cellValue(workbook, '종목별 데이터', `I${row}`)),
      forwardPer: finite(cellValue(workbook, '종목별 데이터', `J${row}`)),
      forwardPerDeltaRatio: finite(cellValue(workbook, '종목별 데이터', `K${row}`)),
      evToEbitda: finite(cellValue(workbook, '종목별 데이터', `L${row}`)),
      priceToFreeCashFlow: finite(cellValue(workbook, '종목별 데이터', `M${row}`)),
      grossMarginRatio: finite(cellValue(workbook, '종목별 데이터', `N${row}`)),
      operatingMarginRatio: finite(cellValue(workbook, '종목별 데이터', `O${row}`)),
      profitMarginRatio: finite(cellValue(workbook, '종목별 데이터', `P${row}`)),
      sourceRow: row,
    };
    interest.push({ ...rowData, drawdownZone: drawdownZone(rowData.drawdownRatio, drawdownThresholds) });
  }

  const c17Proposal = {
    mode: 'proposal_only',
    autoApply: false,
    parameters: {
      drawdownZone: drawdownThresholds,
      spyDrawdown: table(workbook, [49, 50, 51, 52]),
      vix: table(workbook, [58, 59, 60, 61]),
      fearGreed: table(workbook, [65, 66, 67, 68]),
    },
    source: { snapshotHash, revision: identifyJaenongRevision(sourceFileName) },
  };

  return {
    parserVersion: JAENONG_REFERENCE_PARSER_VERSION,
    snapshotHash,
    revision: identifyJaenongRevision(sourceFileName),
    sourceFileName,
    sourceModifiedAt: sourceModifiedAt.toISOString(),
    timing,
    barometer,
    interest,
    c17Proposal,
    quoteFallbacks: fallbacks,
    rawWorkbookIncluded: false,
    shadowOnly: true,
  };
}

function dateOrNull(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const calendar = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/);
    if (calendar) {
      const year = Number(calendar[1]);
      const month = Number(calendar[2]);
      const day = Number(calendar[3]);
      const checked = new Date(Date.UTC(year, month - 1, day));
      if (checked.getUTCFullYear() !== year || checked.getUTCMonth() !== month - 1 || checked.getUTCDate() !== day) {
        return null;
      }
    }
  }
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

function iso(value) {
  return dateOrNull(value)?.toISOString() || null;
}

function normalizedSymbols(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => text(value).toUpperCase())
    .filter((value) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(value)))];
}

export function evaluateJaenongBriefState(input = {}) {
  const now = dateOrNull(input.now || new Date());
  if (!now) throw new Error('jaenong_state_now_invalid');
  if (input.parseStatus === 'failed') {
    return {
      status: 'parse_failed',
      reason: text(input.parseError) || 'parse_failed',
      mayApplyWeight: false,
      checkedAt: now.toISOString(),
    };
  }

  const brief = input.brief;
  if (!brief) {
    return { status: 'absent', reason: 'brief_absent', mayApplyWeight: false, checkedAt: now.toISOString() };
  }
  if (brief.invalidatedAt) {
    return { status: 'invalid', reason: 'brief_invalidated', mayApplyWeight: false, checkedAt: now.toISOString() };
  }

  const publishedAt = dateOrNull(brief.publishedAt);
  const updatedAt = dateOrNull(brief.updatedAt || brief.parsedAt || brief.publishedAt);
  const expiresAt = dateOrNull(brief.expiresAt);
  const adjustment = finite(brief.marketAdjustment);
  if (!text(brief.briefRef) || !publishedAt || !updatedAt || !expiresAt
    || adjustment == null || ![-1, 0, 1].includes(adjustment)) {
    return { status: 'invalid', reason: 'brief_contract_invalid', mayApplyWeight: false, checkedAt: now.toISOString() };
  }
  if (publishedAt.getTime() > now.getTime() + 5 * 60 * 1000) {
    return { status: 'invalid', reason: 'brief_from_future', mayApplyWeight: false, checkedAt: now.toISOString() };
  }
  if (expiresAt.getTime() <= now.getTime()) {
    return { status: 'expired', reason: 'brief_expired', mayApplyWeight: false, checkedAt: now.toISOString() };
  }
  const maxAgeHours = Math.max(1, Number(input.maxAgeHours ?? 30) || 30);
  if (now.getTime() - publishedAt.getTime() > maxAgeHours * 60 * 60 * 1000) {
    return { status: 'stale', reason: 'brief_stale', mayApplyWeight: false, checkedAt: now.toISOString() };
  }

  const acknowledgedAt = dateOrNull(input.ack?.acknowledgedAt);
  const acknowledgedBriefRef = text(input.ack?.briefRef);
  if (acknowledgedBriefRef !== text(brief.briefRef) || !acknowledgedAt
    || acknowledgedAt.getTime() < updatedAt.getTime()) {
    return { status: 'awaiting_ack', reason: 'brief_ack_required', mayApplyWeight: false, checkedAt: now.toISOString() };
  }
  return { status: 'active', reason: 'brief_acknowledged', mayApplyWeight: true, checkedAt: now.toISOString() };
}

export function applyJaenongBriefWeight({ baseScore, candidates = [], brief, state } = {}) {
  const score = finite(baseScore);
  const originalScore = score == null ? baseScore : score;
  const clonedCandidates = (Array.isArray(candidates) ? candidates : []).map((candidate) => structuredClone(candidate));
  if (state?.status !== 'active' || state?.mayApplyWeight !== true || !brief) {
    return {
      score: originalScore,
      candidates: clonedCandidates,
      applied: false,
      reason: state?.reason || 'brief_not_active',
      g6Context: { enabled: false, flagOnly: true, briefRef: text(brief?.briefRef) || null },
    };
  }

  const adjustment = finite(brief.marketAdjustment);
  if (![-1, 0, 1].includes(adjustment)) throw new Error('jaenong_market_adjustment_out_of_range');
  const preferred = new Set(normalizedSymbols(brief.candidateSymbols));
  const weightedCandidates = clonedCandidates.map((candidate) => {
    const symbol = text(candidate.symbol || candidate.ticker).toUpperCase();
    const weight = finite(candidate.weight) ?? 0;
    return preferred.has(symbol)
      ? { ...candidate, weight: weight + 1, jaenongBriefBoost: 1 }
      : candidate;
  });
  return {
    score: score == null ? originalScore : score + adjustment,
    candidates: weightedCandidates,
    applied: true,
    reason: 'acknowledged_brief_applied',
    adjustment,
    g6Context: { enabled: true, flagOnly: true, briefRef: text(brief.briefRef) },
  };
}

export function deriveJaenongMarketAdjustment(marketView = '') {
  const value = text(marketView).toLowerCase();
  const opportunity = [/기회/u, /분할\s*매수/u, /저점/u, /낙폭/u, /조정/u]
    .some((pattern) => pattern.test(value));
  const caution = [/과열/u, /고평가/u, /추격\s*매수/u, /현금\s*비중/u, /매수\s*금지/u]
    .some((pattern) => pattern.test(value));
  if (opportunity === caution) return 0;
  return opportunity ? 1 : -1;
}

export function buildJaenongBriefFromPostScore(row = {}, options = {}) {
  const parsedAt = dateOrNull(row.parsed_at || row.parsedAt || options.now);
  const publishedAt = dateOrNull(row.published_at || row.publishedAt);
  if (!parsedAt || !publishedAt) throw new Error('jaenong_post_score_time_invalid');
  const sourcePostId = text(row.source_post_id || row.sourcePostId || row.post_id || row.postId);
  if (!sourcePostId) throw new Error('jaenong_post_score_identity_required');
  const sourceBrief = row.brief && typeof row.brief === 'object' ? row.brief : {};
  const marketView = text(sourceBrief.marketView);
  const candidateSymbols = normalizedSymbols((sourceBrief.candidates || [])
    .filter((candidate) => candidate?.available === true)
    .map((candidate) => candidate.ticker || candidate.symbol));
  const safeSourceId = sourcePostId.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 96);
  return {
    briefRef: `post:${safeSourceId}`,
    sourceKind: 'post',
    sourcePostId,
    referenceSnapshotHash: text(options.referenceSnapshotHash) || null,
    publishedAt: publishedAt.toISOString(),
    parsedAt: parsedAt.toISOString(),
    updatedAt: parsedAt.toISOString(),
    expiresAt: new Date(parsedAt.getTime() + 30 * 60 * 60 * 1000).toISOString(),
    marketAdjustment: deriveJaenongMarketAdjustment(marketView),
    marketView,
    candidateSymbols,
    state: 'awaiting_ack',
    shadowOnly: true,
  };
}

function briefFromRow(row = {}) {
  return {
    briefRef: text(row.brief_ref || row.briefRef),
    sourceKind: text(row.source_kind || row.sourceKind),
    sourcePostId: row.source_post_id || row.sourcePostId || null,
    referenceSnapshotHash: row.reference_snapshot_hash || row.referenceSnapshotHash || null,
    publishedAt: iso(row.published_at || row.publishedAt),
    parsedAt: iso(row.parsed_at || row.parsedAt),
    updatedAt: iso(row.updated_at || row.updatedAt),
    expiresAt: iso(row.expires_at || row.expiresAt),
    invalidatedAt: iso(row.invalidated_at || row.invalidatedAt),
    invalidReason: row.invalid_reason || row.invalidReason || null,
    marketAdjustment: finite(row.market_adjustment ?? row.marketAdjustment),
    marketView: row.market_view || row.marketView || null,
    candidateSymbols: normalizedSymbols(row.candidate_symbols || row.candidateSymbols),
    state: row.state || null,
  };
}

export async function getJaenongBriefStatus(options = {}, deps = {}) {
  if (options.fixture === true) {
    const now = dateOrNull(options.now || '2026-07-16T12:00:00.000Z');
    const brief = {
      briefRef: 'fixture-jaenong-brief',
      sourceKind: 'fixture',
      publishedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      parsedAt: new Date(now.getTime() - 55 * 60 * 1000).toISOString(),
      updatedAt: new Date(now.getTime() - 55 * 60 * 1000).toISOString(),
      expiresAt: new Date(now.getTime() + 23 * 60 * 60 * 1000).toISOString(),
      marketAdjustment: 1,
      marketView: 'fixture pullback watch',
      candidateSymbols: ['MSFT'],
    };
    const ack = { briefRef: brief.briefRef, acknowledgedAt: new Date(now.getTime() - 30 * 60 * 1000).toISOString() };
    return {
      ok: true,
      mode: 'read_only_fixture',
      brief,
      ack,
      state: evaluateJaenongBriefState({ now, brief, ack }),
      mutationAllowed: false,
      shadowOnly: true,
    };
  }

  const queryFn = deps.queryFn;
  if (typeof queryFn !== 'function') throw new Error('jaenong_brief_query_function_required');
  const rows = await queryFn(
    `WITH latest_brief AS (
       SELECT * FROM investment.jaenong_brief
        ORDER BY published_at DESC, id DESC
        LIMIT 1
     ), latest_failure AS (
       SELECT event_type, reason, created_at
         FROM investment.jaenong_brief_event
        WHERE event_type = 'parse_failed'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
     )
     SELECT b.*, a.acknowledged_at, a.actor AS acknowledged_by,
            e.event_type AS latest_event_type, e.reason AS latest_event_reason,
            e.created_at AS latest_event_at
       FROM (SELECT 1) root
       LEFT JOIN latest_brief b ON true
       LEFT JOIN LATERAL (
         SELECT acknowledged_at, actor
           FROM investment.jaenong_brief_ack
          WHERE brief_ref = b.brief_ref
          ORDER BY acknowledged_at DESC
          LIMIT 1
       ) a ON true
       LEFT JOIN latest_failure e ON true`,
    [],
  );
  if (!rows?.[0]?.brief_ref) {
    const parseFailure = rows?.[0]?.latest_event_type === 'parse_failed';
    return {
      ok: true,
      mode: 'read_only',
      brief: null,
      ack: null,
      state: evaluateJaenongBriefState({
        now: options.now,
        parseStatus: parseFailure ? 'failed' : null,
        parseError: rows?.[0]?.latest_event_reason || null,
      }),
      mutationAllowed: false,
      shadowOnly: true,
    };
  }
  const row = rows[0];
  const brief = briefFromRow(row);
  const ack = row.acknowledged_at
    ? { briefRef: brief.briefRef, acknowledgedAt: iso(row.acknowledged_at), actor: row.acknowledged_by || null }
    : null;
  return {
    ok: true,
    mode: 'read_only',
    brief,
    ack,
    state: evaluateJaenongBriefState({
      now: options.now,
      brief,
      ack,
      parseStatus: row.latest_event_type === 'parse_failed'
        && dateOrNull(row.latest_event_at)?.getTime() > dateOrNull(brief.updatedAt)?.getTime()
        ? 'failed'
        : null,
      parseError: row.latest_event_reason || null,
    }),
    mutationAllowed: false,
    shadowOnly: true,
  };
}

function commandParts(command) {
  return text(command).split(/\s+/).filter(Boolean);
}

function validBriefRef(value) {
  const ref = text(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{3,127}$/.test(ref)) throw new Error('jaenong_brief_ref_invalid');
  return ref;
}

function requireActor(actor) {
  const normalized = text(actor);
  if (!normalized) throw new Error('jaenong_command_actor_required');
  return normalized;
}

export async function handleJaenongCommand(command, deps = {}) {
  const parts = commandParts(command);
  if (!/^\/jaenong(?:@[A-Za-z0-9_]+)?$/i.test(parts[0] || '')) throw new Error('jaenong_command_invalid');
  const action = text(parts[1] || 'status').toLowerCase();
  const now = (typeof deps.now === 'function' ? deps.now() : new Date());
  if (!dateOrNull(now)) throw new Error('jaenong_command_now_invalid');

  if (action === 'status') {
    const status = await getJaenongBriefStatus({ now }, { queryFn: deps.queryFn });
    return { ...status, action: 'status' };
  }

  const actor = requireActor(deps.actor);
  if (typeof deps.runFn !== 'function') throw new Error('jaenong_command_run_function_required');
  if (action === 'ack') {
    const briefRef = validBriefRef(parts[2]);
    const result = await deps.runFn(
      `INSERT INTO investment.jaenong_brief_ack (brief_ref, actor, acknowledged_at)
       SELECT brief_ref, $2, $3 FROM investment.jaenong_brief
        WHERE brief_ref = $1 AND shadow_only = true
       ON CONFLICT (brief_ref, actor) DO UPDATE SET acknowledged_at = EXCLUDED.acknowledged_at`,
      [briefRef, actor, dateOrNull(now).toISOString()],
    );
    if (Number(result?.rowCount || 0) === 0) throw new Error('jaenong_brief_not_found');
    return { ok: true, action: 'ack', briefRef, actor, shadowOnly: true };
  }

  if (action === 'set') {
    const adjustment = finite(parts[2]);
    if (![-1, 0, 1].includes(adjustment)) throw new Error('jaenong_market_adjustment_out_of_range');
    const symbols = normalizedSymbols(text(parts[3]).split(','));
    const note = text(parts.slice(4).join(' '));
    if (!note) throw new Error('jaenong_manual_note_required');
    const timestamp = dateOrNull(now);
    const briefRef = `manual-${timestamp.toISOString().replace(/[-:.]/g, '').replace('000Z', 'Z')}`;
    await deps.runFn(
      `INSERT INTO investment.jaenong_brief
         (brief_ref, source_kind, published_at, parsed_at, expires_at, market_adjustment,
          market_view, candidate_symbols, state, shadow_only, updated_at)
       VALUES ($1, 'manual', $2, $2, $3, $4, $5, $6::jsonb, 'awaiting_ack', true, $2)`,
      [
        briefRef,
        timestamp.toISOString(),
        new Date(timestamp.getTime() + 30 * 60 * 60 * 1000).toISOString(),
        adjustment,
        note,
        JSON.stringify(symbols),
      ],
    );
    return { ok: true, action: 'set', briefRef, state: 'awaiting_ack', shadowOnly: true };
  }

  if (action === 'correct') {
    const briefRef = validBriefRef(parts[2]);
    const adjustment = finite(parts[3]);
    if (![-1, 0, 1].includes(adjustment)) throw new Error('jaenong_market_adjustment_out_of_range');
    const symbols = normalizedSymbols(text(parts[4]).split(','));
    const note = text(parts.slice(5).join(' '));
    if (!note) throw new Error('jaenong_manual_note_required');
    const result = await deps.runFn(
      `UPDATE investment.jaenong_brief
          SET market_adjustment = $2, market_view = $3, candidate_symbols = $4::jsonb,
              state = 'awaiting_ack', invalidated_at = NULL, invalid_reason = NULL, updated_at = $5
        WHERE brief_ref = $1 AND shadow_only = true`,
      [briefRef, adjustment, note, JSON.stringify(symbols), dateOrNull(now).toISOString()],
    );
    if (Number(result?.rowCount || 0) === 0) throw new Error('jaenong_brief_not_found');
    return { ok: true, action: 'correct', briefRef, state: 'awaiting_ack', shadowOnly: true };
  }

  if (action === 'invalidate') {
    const briefRef = validBriefRef(parts[2]);
    const reason = text(parts.slice(3).join(' '));
    if (!reason) throw new Error('jaenong_invalidation_reason_required');
    const result = await deps.runFn(
      `UPDATE investment.jaenong_brief
          SET state = 'invalid', invalidated_at = $2, invalid_reason = $3, updated_at = $2
        WHERE brief_ref = $1 AND shadow_only = true`,
      [briefRef, dateOrNull(now).toISOString(), reason],
    );
    if (Number(result?.rowCount || 0) === 0) throw new Error('jaenong_brief_not_found');
    return { ok: true, action: 'invalidate', briefRef, state: 'invalid', shadowOnly: true };
  }

  throw new Error('jaenong_command_action_invalid');
}

function riskNumber(c17, field, validator) {
  const value = finite(c17?.[JAENONG_C17_PARAMETER_KEYS[field]] ?? c17?.[field]);
  return value != null && validator(value) ? value : JAENONG_C17_DEFAULTS[field];
}

function jaenongTrackRisk(c17 = {}) {
  const zoneStopLoss = c17?.[JAENONG_C17_PARAMETER_KEYS.zoneStopLossAlpha] ?? c17?.zoneStopLossAlpha;
  const zoneStopLossAlpha = zoneStopLoss == null || zoneStopLoss === ''
    ? JAENONG_C17_DEFAULTS.zoneStopLossAlpha
    : riskNumber(c17, 'zoneStopLossAlpha', (value) => value >= 0 && value <= 1);
  return {
    consumed: true,
    capitalBudgetRatio: riskNumber(c17, 'capitalBudgetRatio', (value) => value > 0 && value <= 1),
    averagingMaxCount: Math.trunc(riskNumber(c17, 'averagingMaxCount', (value) => value >= 0 && value <= 20)),
    trackMddCircuitPct: riskNumber(c17, 'trackMddCircuitPct', (value) => value < 0 && value >= -100),
    zoneStopLossAlpha,
    enforcement: 'shadow_record_only',
  };
}

function referenceZoneWeight(zone) {
  return ({ deep: 2, pullback: 1, watch: 0.5, neutral: 0 }[text(zone).toLowerCase()] ?? 0);
}

export function buildJaenongPriorityRoute(input = {}) {
  const signalRef = text(input.signalRef);
  const createdAt = dateOrNull(input.createdAt || new Date());
  if (!signalRef) throw new Error('jaenong_route_signal_ref_required');
  if (!createdAt) throw new Error('jaenong_route_created_at_invalid');
  const pullbackCandidates = (Array.isArray(input.pullbackCandidates) ? input.pullbackCandidates : [])
    .map((candidate) => structuredClone(candidate));
  const topVolumeCandidates = (Array.isArray(input.topVolumeCandidates) ? input.topVolumeCandidates : [])
    .map((candidate) => structuredClone(candidate));
  const pullbackAvailable = input.pullbackScore?.available === true
    && finite(input.pullbackScore?.total) != null
    && pullbackCandidates.length > 0;
  const risk = jaenongTrackRisk(input.c17);

  if (!pullbackAvailable) {
    return {
      signalRef,
      createdAt: createdAt.toISOString(),
      selectedTrack: 'top-volume',
      priority: 2,
      reason: 'pullback_unavailable_top_volume_fallback',
      selectedCandidates: topVolumeCandidates,
      treatment: {
        track: 'top-volume',
        score: null,
        candidates: topVolumeCandidates.map((candidate) => structuredClone(candidate)),
        briefApplied: false,
        tranchePlan: buildJaenongTranchePlan(null),
      },
      control: {
        track: 'top-volume',
        score: null,
        candidates: topVolumeCandidates.map((candidate) => structuredClone(candidate)),
        briefApplied: false,
        tranchePlan: buildJaenongTranchePlan(null),
      },
      referenceSnapshotHash: null,
      briefRef: null,
      risk,
      shadowOnly: true,
      executionConnected: false,
      orderPath: null,
    };
  }

  const referenceRows = Array.isArray(input.referenceSnapshot?.interest) ? input.referenceSnapshot.interest : [];
  const referenceBySymbol = new Map(referenceRows.map((row) => [text(row.symbol).toUpperCase(), row]));
  const referenceWeighted = pullbackCandidates.map((candidate) => {
    const symbol = text(candidate.symbol || candidate.ticker).toUpperCase();
    const reference = referenceBySymbol.get(symbol);
    const referenceDrawdownZone = text(reference?.drawdownZone).toLowerCase() || 'unknown';
    return {
      ...candidate,
      symbol,
      weight: referenceZoneWeight(referenceDrawdownZone),
      referenceDrawdownZone,
      referenceWeight: referenceZoneWeight(referenceDrawdownZone),
    };
  });
  const treatmentWeight = applyJaenongBriefWeight({
    baseScore: input.pullbackScore.total,
    candidates: referenceWeighted,
    brief: input.brief,
    state: input.briefState,
  });
  const treatmentCandidates = treatmentWeight.candidates.toSorted((left, right) => (
    (finite(right.weight) ?? 0) - (finite(left.weight) ?? 0)
      || (finite(left.drawdownPct) ?? 0) - (finite(right.drawdownPct) ?? 0)
      || text(left.symbol).localeCompare(text(right.symbol))
  ));
  const controlScore = finite(input.pullbackScore.total);
  return {
    signalRef,
    createdAt: createdAt.toISOString(),
    selectedTrack: 'pullback',
    priority: 1,
    reason: 'jaenong_pullback_primary_shadow',
    selectedCandidates: treatmentCandidates.map((candidate) => structuredClone(candidate)),
    treatment: {
      track: 'pullback',
      score: treatmentWeight.score,
      candidates: treatmentCandidates,
      briefApplied: treatmentWeight.applied,
      briefReason: treatmentWeight.reason,
      g6Context: treatmentWeight.g6Context,
      tranchePlan: buildJaenongTranchePlan(treatmentWeight.score),
    },
    control: {
      track: 'pullback',
      score: controlScore,
      candidates: pullbackCandidates,
      briefApplied: false,
      tranchePlan: buildJaenongTranchePlan(controlScore),
    },
    referenceSnapshotHash: text(input.referenceSnapshot?.snapshotHash) || null,
    briefRef: treatmentWeight.applied ? text(input.brief?.briefRef) || null : null,
    risk,
    shadowOnly: true,
    executionConnected: false,
    orderPath: null,
  };
}

export async function recordJaenongRouteShadow(route, runFn) {
  if (typeof runFn !== 'function') throw new Error('jaenong_route_run_function_required');
  if (!route?.signalRef || route?.shadowOnly !== true || route?.executionConnected !== false || route?.orderPath != null) {
    throw new Error('jaenong_route_shadow_contract_invalid');
  }
  const result = await runFn(
    `INSERT INTO investment.jaenong_route_shadow
       (signal_ref, created_at, selected_track, priority, selected_candidates,
        treatment, control_group, reference_snapshot_hash, brief_ref, c17_risk,
        shadow_only, execution_connected)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb, true, false)
     ON CONFLICT (signal_ref) DO NOTHING`,
    [
      route.signalRef,
      route.createdAt,
      route.selectedTrack,
      route.priority,
      JSON.stringify(route.selectedCandidates),
      JSON.stringify(route.treatment),
      JSON.stringify(route.control),
      route.referenceSnapshotHash,
      route.briefRef,
      JSON.stringify(route.risk),
    ],
  );
  const recorded = Number(result?.rowCount || 0) > 0;
  return { recorded, skipped: !recorded, reason: recorded ? null : 'duplicate_signal_ref', shadowOnly: true };
}

export function jaenongBriefPreflight({ brief, state, now = new Date() } = {}) {
  const checkedAt = dateOrNull(now);
  if (!checkedAt) throw new Error('jaenong_preflight_now_invalid');
  const expiresAt = dateOrNull(brief?.expiresAt);
  const checks = [
    {
      name: 'contract',
      ok: Boolean(text(brief?.briefRef)) && [-1, 0, 1].includes(finite(brief?.marketAdjustment)),
    },
    {
      name: 'freshness',
      ok: Boolean(expiresAt) && expiresAt.getTime() > checkedAt.getTime()
        && !['stale', 'expired', 'invalid', 'parse_failed', 'absent'].includes(state?.status),
    },
    {
      name: 'ack',
      ok: state?.status === 'active' && state?.mayApplyWeight === true,
    },
  ];
  const ok = checks.every((check) => check.ok);
  return {
    ok,
    advisoryOnly: true,
    checks,
    briefRef: text(brief?.briefRef) || null,
    checkedAt: checkedAt.toISOString(),
    placed: false,
    liveMutation: false,
    reason: ok ? 'jaenong_brief_preflight_read_checks_recorded' : 'jaenong_brief_preflight_incomplete',
  };
}

export function attachJaenongAttribution(plan = {}, route = {}) {
  if (route?.shadowOnly !== true || route?.executionConnected !== false) {
    throw new Error('jaenong_attribution_shadow_route_required');
  }
  return {
    ...structuredClone(plan),
    attribution: {
      briefRef: route.briefRef || null,
      referenceSnapshotHash: route.referenceSnapshotHash || null,
      trackTag: `jaenong:${route.selectedTrack}:treatment`,
      controlTrackTag: `jaenong:${route.control?.track || route.selectedTrack}:control`,
      signalRef: route.signalRef,
    },
    shadowOnly: true,
    executionConnected: false,
    orderPath: null,
  };
}

export function invalidateJaenongBriefState(brief = {}, options = {}) {
  const briefRef = validBriefRef(brief.briefRef);
  const now = dateOrNull(options.now || new Date());
  const reason = text(options.reason);
  if (!now) throw new Error('jaenong_invalidation_time_invalid');
  if (!reason) throw new Error('jaenong_invalidation_reason_required');
  return {
    ...structuredClone(brief),
    briefRef,
    state: 'invalid',
    invalidatedAt: now.toISOString(),
    invalidReason: reason,
    updatedAt: now.toISOString(),
    shadowOnly: true,
  };
}

export async function getJaenongRetroSummary(options = {}, deps = {}) {
  if (options.fixture === true) {
    return {
      ok: true,
      mode: 'read_only_fixture',
      routes: 4,
      pullbackRoutes: 3,
      topVolumeFallbacks: 1,
      briefAppliedRoutes: 2,
      averageTreatmentControlDelta: 0.5,
      parsedPosts: 3,
      mutationAllowed: false,
      shadowOnly: true,
    };
  }
  if (typeof deps.queryFn !== 'function') throw new Error('jaenong_retro_query_function_required');
  const rows = await deps.queryFn(
    `SELECT
       (SELECT COUNT(*)::int FROM investment.jaenong_route_shadow) AS routes,
       (SELECT COUNT(*)::int FROM investment.jaenong_route_shadow WHERE selected_track = 'pullback') AS pullback_routes,
       (SELECT COUNT(*)::int FROM investment.jaenong_route_shadow WHERE selected_track = 'top-volume') AS top_volume_fallbacks,
       (SELECT COUNT(*)::int FROM investment.jaenong_route_shadow
         WHERE COALESCE((treatment->>'briefApplied')::boolean, false)) AS brief_applied_routes,
       (SELECT AVG((treatment->>'score')::numeric - (control_group->>'score')::numeric)
          FROM investment.jaenong_route_shadow
         WHERE treatment->>'score' IS NOT NULL AND control_group->>'score' IS NOT NULL) AS avg_delta,
       (SELECT COUNT(*)::int FROM investment.jaenong_post_scores) AS parsed_posts`,
    [],
  );
  const row = rows?.[0] || {};
  return {
    ok: true,
    mode: 'read_only',
    routes: Number(row.routes || 0),
    pullbackRoutes: Number(row.pullback_routes || 0),
    topVolumeFallbacks: Number(row.top_volume_fallbacks || 0),
    briefAppliedRoutes: Number(row.brief_applied_routes || 0),
    averageTreatmentControlDelta: finite(row.avg_delta) ?? 0,
    parsedPosts: Number(row.parsed_posts || 0),
    mutationAllowed: false,
    shadowOnly: true,
  };
}
