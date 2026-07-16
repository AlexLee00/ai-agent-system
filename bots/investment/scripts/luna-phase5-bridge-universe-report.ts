#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db/core.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  isolateLunaOutcomeOutliers,
  sanitizeLunaLearnedBiasWeightMap,
} from '../shared/luna-data-contracts.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DEFAULT_MIN_PERIOD_ROWS = 7;
const DEFAULT_OUTLIER_MIN_GROUP_N = 5;
const EXPECTED_BRIDGE_STATUS = 'shadow_read_only_ready';
const TIME_ZONE = 'Asia/Seoul';
const UNIVERSE_REFRESH_LOCAL_TIME = '08:30';

export const BRIDGE_UNIVERSE_WEEKLY_REPORT_SQL = `
  SELECT 'bridge'::text AS source_kind,
         id::text AS source_id,
         observed_at AS event_at,
         skill_id, mcp_tool_name, status AS bridge_status,
         direct_trade_allowed, protected_policy, capability, evidence,
         NULL::text AS regime, NULL::text AS exchange,
         NULL::jsonb AS axis_weights, NULL::jsonb AS selected_symbols,
         NULL::integer AS universe_size, NULL::boolean AS shadow_only
    FROM investment.luna_phase5_mcp_a2a_bridge_shadow
   WHERE observed_at >= $1::timestamptz
     AND observed_at < $2::timestamptz
  UNION ALL
  SELECT 'universe'::text AS source_kind,
         id::text AS source_id,
         selected_at AS event_at,
         NULL::text AS skill_id, NULL::text AS mcp_tool_name,
         NULL::text AS bridge_status, NULL::boolean AS direct_trade_allowed,
         NULL::text AS protected_policy, NULL::jsonb AS capability, NULL::jsonb AS evidence,
         regime, exchange, axis_weights, selected_symbols, universe_size, shadow_only
    FROM investment.universe_selection_shadow
   WHERE selected_at >= $1::timestamptz
     AND selected_at < $2::timestamptz
   ORDER BY event_at ASC, source_id ASC
`;

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 6) {
  return value == null ? null : Number(Number(value).toFixed(digits));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? round(numerator / denominator) : null;
}

function mean(values) {
  return values.length > 0
    ? round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : null;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRealCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function parseLunaReportTimestamp(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value.trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetText] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  if (!isRealCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
  if (offsetText !== 'Z') {
    const [offsetHour, offsetMinute] = offsetText.slice(1).split(':').map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return null;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function compareIds(left, right) {
  const leftText = String(left ?? '');
  const rightText = String(right ?? '');
  if (/^\d+$/.test(leftText) && /^\d+$/.test(rightText)) {
    const leftNumber = BigInt(leftText);
    const rightNumber = BigInt(rightText);
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }
  return leftText.localeCompare(rightText);
}

function kstDateKey(date) {
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function addCalendarDays(dateKey, days) {
  const match = String(dateKey).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const [year, month, day] = [yearText, monthText, dayText].map(Number);
  if (!isRealCalendarDate(year, month, day)) return null;
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function refreshInstantForDate(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 8, 30) - KST_OFFSET_MS);
}

function kstCalendarDayBounds(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day) - KST_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

function expectedRefreshDates(start, end) {
  const dates = [];
  let dateKey = addCalendarDays(kstDateKey(start), -1);
  const finalKey = addCalendarDays(kstDateKey(end), 1);
  while (dateKey && dateKey <= finalKey) {
    const instant = refreshInstantForDate(dateKey);
    if (instant >= start && instant < end) dates.push(dateKey);
    dateKey = addCalendarDays(dateKey, 1);
  }
  return dates;
}

function buildWindow(asOfInput) {
  const asOf = parseLunaReportTimestamp(asOfInput);
  if (!asOf) throw new Error('invalid --as-of timestamp; an existing ISO calendar instant with timezone is required');
  const recentStart = new Date(asOf.getTime() - 7 * DAY_MS);
  const previousStart = new Date(asOf.getTime() - 14 * DAY_MS);
  return {
    previous: { start: previousStart, end: recentStart },
    recent: { start: recentStart, end: asOf },
  };
}

function periodOf(date, window) {
  if (date >= window.recent.start && date < window.recent.end) return 'recent';
  if (date >= window.previous.start && date < window.previous.end) return 'previous';
  return null;
}

function countBy(items, valueOf) {
  const counts = new Map();
  for (const item of items) {
    const key = String(valueOf(item) || 'unknown');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count, rate: ratio(count, items.length) }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function dedupeObservations(items) {
  const selected = new Map();
  const signatures = new Map();
  let duplicateRows = 0;
  for (const item of items) {
    if (!signatures.has(item.exactKey)) signatures.set(item.exactKey, new Set());
    signatures.get(item.exactKey).add(item.conflictSignature);
    if (selected.has(item.exactKey)) duplicateRows += 1;
    const current = selected.get(item.exactKey);
    if (!current || compareIds(current.id, item.id) < 0) selected.set(item.exactKey, item);
  }
  return {
    rows: [...selected.values()].sort((left, right) => (
      left.timestamp.getTime() - right.timestamp.getTime() || compareIds(left.id, right.id)
    )),
    duplicateRows,
    conflictingDuplicateKeys: [...signatures.values()].filter((values) => values.size > 1).length,
  };
}

function anomalyCounts(items) {
  const result = {};
  for (const item of items) {
    for (const reason of item.anomalyReasons) result[reason] = (result[reason] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function bridgePeriod(items, minPeriodRows) {
  const anomalyRows = items.filter((item) => item.anomalyReasons.length > 0).length;
  return {
    rows: items.length,
    sampleStatus: items.length >= minPeriodRows ? 'sufficient' : 'insufficient',
    activeDays: new Set(items.map((item) => item.dateKey)).size,
    uniqueSkills: new Set(items.map((item) => item.skillId)).size,
    uniqueTools: new Set(items.map((item) => item.toolName)).size,
    statusDistribution: countBy(items, (item) => item.status),
    anomalyRows,
    anomalyRate: ratio(anomalyRows, items.length),
  };
}

function normalizeBridgeRow(row) {
  const timestamp = parseLunaReportTimestamp(row.observed_at ?? row.observedAt);
  const skillId = String(row.skill_id ?? row.skillId ?? '').trim();
  const toolName = String(row.mcp_tool_name ?? row.mcpToolName ?? '').trim();
  const status = String(row.status ?? row.bridge_status ?? '').trim();
  const directTradeAllowed = row.direct_trade_allowed ?? row.directTradeAllowed;
  if (!timestamp) return { invalidReason: 'invalidObservedAt' };
  if (!skillId) return { invalidReason: 'missingSkillId' };
  if (!toolName) return { invalidReason: 'missingToolName' };
  if (!status) return { invalidReason: 'missingStatus' };
  if (typeof directTradeAllowed !== 'boolean') return { invalidReason: 'invalidDirectTradeAllowed' };
  const capability = parseJsonObject(row.capability);
  const evidence = parseJsonObject(row.evidence);
  const protectedPolicy = String(row.protected_policy ?? row.protectedPolicy ?? '').trim();
  const anomalyReasons = [];
  if (directTradeAllowed) anomalyReasons.push('directTradeAllowed');
  if (status !== EXPECTED_BRIDGE_STATUS) anomalyReasons.push('unexpectedStatus');
  if (!protectedPolicy) anomalyReasons.push('missingProtectedPolicy');
  if (capability?.writeMode && !['read_only', 'read_only_or_shadow_only'].includes(capability.writeMode)) {
    anomalyReasons.push('writeModeOutsideReadOnlyBoundary');
  }
  if (evidence?.liveMutation === true) anomalyReasons.push('liveMutationEvidence');
  const id = String(row.id ?? '');
  return {
    id,
    timestamp,
    dateKey: kstDateKey(timestamp),
    skillId,
    toolName,
    status,
    directTradeAllowed,
    protectedPolicy,
    capability,
    evidence,
    anomalyReasons,
    exactKey: [skillId, toolName, timestamp.toISOString()].join('|'),
    conflictSignature: stableStringify({ status, directTradeAllowed, protectedPolicy, capability, evidence }),
  };
}

function buildBridgeReport(rows, window, options) {
  const invalidByReason = {
    invalidObservedAt: 0,
    missingSkillId: 0,
    missingToolName: 0,
    missingStatus: 0,
    invalidDirectTradeAllowed: 0,
  };
  const valid = [];
  for (const row of rows) {
    const normalized = normalizeBridgeRow(row);
    if (normalized.invalidReason) invalidByReason[normalized.invalidReason] += 1;
    else valid.push(normalized);
  }
  const deduped = dedupeObservations(valid);
  const inWindow = deduped.rows.filter((item) => periodOf(item.timestamp, window));
  const recentItems = inWindow.filter((item) => periodOf(item.timestamp, window) === 'recent');
  const previousItems = inWindow.filter((item) => periodOf(item.timestamp, window) === 'previous');
  const recent = bridgePeriod(recentItems, options.minPeriodRows);
  const previous = bridgePeriod(previousItems, options.minPeriodRows);
  const comparisonStatus = recent.sampleStatus === 'sufficient' && previous.sampleStatus === 'sufficient'
    ? 'sufficient'
    : 'insufficient';
  const allDailyCounts = [...inWindow.reduce((groups, item) => {
    groups.set(item.dateKey, (groups.get(item.dateKey) || 0) + 1);
    return groups;
  }, new Map()).entries()]
    .map(([date, count]) => ({ id: date, date, count, realizedReward: count, outcomeUnit: 'events_per_kst_day' }))
    .sort((left, right) => left.date.localeCompare(right.date));
  const dailyCounts = allDailyCounts.filter((item) => {
    const bounds = kstCalendarDayBounds(item.date);
    return bounds.start >= window.previous.start && bounds.end <= window.recent.end;
  });
  const outliers = isolateLunaOutcomeOutliers(dailyCounts, { minGroupN: options.outlierMinGroupN });
  const invalidRows = Object.values(invalidByReason).reduce((sum, count) => sum + count, 0);
  return {
    audit: {
      rawRows: rows.length,
      validRows: valid.length,
      dedupedRows: deduped.rows.length,
      duplicateRows: deduped.duplicateRows,
      conflictingDuplicateKeys: deduped.conflictingDuplicateKeys,
      exactDuplicateKey: ['skill_id', 'mcp_tool_name', 'observed_at'],
      invalidRows,
      invalidByReason,
      outOfWindowRows: deduped.rows.length - inWindow.length,
    },
    recent,
    previous,
    comparison: {
      status: comparisonStatus,
      eventCountDelta: recent.rows - previous.rows,
      eventCountDeltaRatio: comparisonStatus === 'sufficient' ? ratio(recent.rows - previous.rows, previous.rows) : null,
      eventCountDirection: comparisonStatus === 'sufficient'
        ? recent.rows > previous.rows ? 'up' : recent.rows < previous.rows ? 'down' : 'flat'
        : 'insufficient',
      anomalyRateDelta: comparisonStatus === 'sufficient' && recent.anomalyRate != null && previous.anomalyRate != null
        ? round(recent.anomalyRate - previous.anomalyRate)
        : null,
    },
    anomalies: {
      rows: inWindow.filter((item) => item.anomalyReasons.length > 0).length,
      patterns: anomalyCounts(inWindow),
    },
    dailyVolume: {
      unit: 'events_per_kst_day',
      rows: dailyCounts,
      partialBoundaryDaysExcluded: allDailyCounts.length - dailyCounts.length,
      outlierDays: outliers.excluded.map((item) => item.date).sort(),
      outlierAudit: outliers.audit,
    },
  };
}

function normalizeSelectedSymbols(value) {
  const entries = parseJsonArray(value);
  if (!entries) return null;
  const symbols = [];
  let invalidEntries = 0;
  let invalidScores = 0;
  for (const entry of entries) {
    const symbol = String(typeof entry === 'string' ? entry : entry?.symbol ?? '').trim().toUpperCase();
    if (!symbol) invalidEntries += 1;
    else symbols.push(symbol);
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && 'score' in entry) {
      const score = finiteOrNull(entry.score);
      if (score == null || score < 0 || score > 1) invalidScores += 1;
    }
  }
  const uniqueSymbols = [...new Set(symbols)].sort();
  return {
    symbols: uniqueSymbols,
    rawSymbolCount: symbols.length,
    duplicateSymbols: symbols.length - uniqueSymbols.length,
    invalidEntries,
    invalidScores,
  };
}

function normalizeUniverseRow(row) {
  const timestamp = parseLunaReportTimestamp(row.selected_at ?? row.selectedAt);
  const exchange = String(row.exchange || '').trim().toLowerCase();
  const regime = String(row.regime || '').trim().toUpperCase();
  const selection = normalizeSelectedSymbols(row.selected_symbols ?? row.selectedSymbols);
  if (!timestamp) return { invalidReason: 'invalidSelectedAt' };
  if (!exchange) return { invalidReason: 'missingExchange' };
  if (!regime) return { invalidReason: 'missingRegime' };
  if (!selection) return { invalidReason: 'invalidSelectedSymbols' };
  const axisWeights = parseJsonObject(row.axis_weights ?? row.axisWeights) || {};
  const weightContract = sanitizeLunaLearnedBiasWeightMap(axisWeights, {
    allowedKeys: ['volume', 'cap', 'sector'],
  });
  const weightSum = Object.values(weightContract.weights).reduce((sum, value) => sum + value, 0);
  const universeSize = finiteOrNull(row.universe_size ?? row.universeSize);
  const anomalyReasons = [];
  if (weightContract.rejected.length > 0 || Object.keys(weightContract.weights).length !== 3 || Math.abs(weightSum - 1) > 1e-6) {
    anomalyReasons.push('invalidAxisWeightContract');
  }
  if (selection.invalidEntries > 0) anomalyReasons.push('invalidSelectedSymbolEntries');
  if (selection.invalidScores > 0) anomalyReasons.push('invalidSelectionScores');
  if (selection.duplicateSymbols > 0) anomalyReasons.push('duplicateSymbols');
  if (universeSize == null || !Number.isInteger(universeSize) || universeSize < 0) anomalyReasons.push('invalidUniverseSize');
  else if (universeSize !== selection.symbols.length) anomalyReasons.push('universeSizeMismatch');
  if (row.shadow_only !== true && row.shadowOnly !== true) anomalyReasons.push('notShadowOnly');
  const id = String(row.id ?? '');
  return {
    id,
    timestamp,
    dateKey: kstDateKey(timestamp),
    exchange,
    regime,
    axisWeights: weightContract.weights,
    weightRejected: weightContract.rejected,
    weightSum: round(weightSum),
    symbols: selection.symbols,
    duplicateSymbols: selection.duplicateSymbols,
    invalidSymbolEntries: selection.invalidEntries,
    invalidSelectionScores: selection.invalidScores,
    universeSize,
    shadowOnly: row.shadow_only === true || row.shadowOnly === true,
    anomalyReasons,
    exactKey: [exchange, regime, timestamp.toISOString()].join('|'),
    conflictSignature: stableStringify({ axisWeights, symbols: selection.symbols, universeSize, shadowOnly: row.shadow_only ?? row.shadowOnly }),
  };
}

function universePeriod(items, minPeriodRows) {
  return {
    rows: items.length,
    sampleStatus: items.length >= minPeriodRows ? 'sufficient' : 'insufficient',
    activeDays: new Set(items.map((item) => item.dateKey)).size,
    exchanges: countBy(items, (item) => item.exchange),
    regimes: countBy(items, (item) => item.regime),
    meanUniverseSize: mean(items.map((item) => item.universeSize).filter((value) => value != null)),
  };
}

function selectionChangeAudit(items, recentStart) {
  const byExchange = new Map();
  for (const item of items) {
    if (!byExchange.has(item.exchange)) byExchange.set(item.exchange, []);
    byExchange.get(item.exchange).push(item);
  }
  const transitions = [];
  for (const [exchange, exchangeItems] of byExchange.entries()) {
    exchangeItems.sort((left, right) => left.timestamp - right.timestamp || compareIds(left.id, right.id));
    for (let index = 1; index < exchangeItems.length; index += 1) {
      const previous = exchangeItems[index - 1];
      const current = exchangeItems[index];
      if (current.timestamp < recentStart) continue;
      const previousSet = new Set(previous.symbols);
      const currentSet = new Set(current.symbols);
      const added = current.symbols.filter((symbol) => !previousSet.has(symbol));
      const removed = previous.symbols.filter((symbol) => !currentSet.has(symbol));
      const intersection = current.symbols.filter((symbol) => previousSet.has(symbol)).length;
      const union = new Set([...previous.symbols, ...current.symbols]).size;
      transitions.push({
        exchange,
        from: previous.timestamp.toISOString(),
        to: current.timestamp.toISOString(),
        fromRegime: previous.regime,
        toRegime: current.regime,
        added,
        removed,
        changed: added.length > 0 || removed.length > 0,
        jaccardSimilarity: union > 0 ? round(intersection / union) : 1,
      });
    }
  }
  transitions.sort((left, right) => left.to.localeCompare(right.to) || left.exchange.localeCompare(right.exchange));
  return {
    status: transitions.length > 0 ? 'sufficient' : 'insufficient',
    transitions: transitions.length,
    changedTransitions: transitions.filter((item) => item.changed).length,
    meanJaccardSimilarity: mean(transitions.map((item) => item.jaccardSimilarity)),
    details: transitions,
  };
}

function buildUniverseReport(rows, window, options) {
  const invalidByReason = {
    invalidSelectedAt: 0,
    missingExchange: 0,
    missingRegime: 0,
    invalidSelectedSymbols: 0,
  };
  const valid = [];
  for (const row of rows) {
    const normalized = normalizeUniverseRow(row);
    if (normalized.invalidReason) invalidByReason[normalized.invalidReason] += 1;
    else valid.push(normalized);
  }
  const deduped = dedupeObservations(valid);
  const inWindow = deduped.rows.filter((item) => periodOf(item.timestamp, window));
  const recentItems = inWindow.filter((item) => periodOf(item.timestamp, window) === 'recent');
  const previousItems = inWindow.filter((item) => periodOf(item.timestamp, window) === 'previous');
  const recent = universePeriod(recentItems, options.minPeriodRows);
  const previous = universePeriod(previousItems, options.minPeriodRows);
  const comparisonStatus = recent.sampleStatus === 'sufficient' && previous.sampleStatus === 'sufficient'
    ? 'sufficient'
    : 'insufficient';
  const expectedDates = expectedRefreshDates(window.recent.start, window.recent.end);
  const actualDates = [...new Set(recentItems.map((item) => item.dateKey))].sort();
  const exchanges = [...new Set(inWindow.map((item) => item.exchange))].sort();
  const byExchange = exchanges.map((exchange) => {
    const dates = new Set(recentItems.filter((item) => item.exchange === exchange).map((item) => item.dateKey));
    return {
      exchange,
      observedDates: [...dates].sort(),
      missingDates: expectedDates.filter((date) => !dates.has(date)),
    };
  });
  const latestByExchange = exchanges.map((exchange) => {
    const latest = [...recentItems].reverse().find((item) => item.exchange === exchange);
    return latest ? {
      exchange,
      selectedAt: latest.timestamp.toISOString(),
      regime: latest.regime,
      universeSize: latest.universeSize,
      symbols: latest.symbols,
    } : { exchange, selectedAt: null, regime: null, universeSize: null, symbols: [] };
  });
  const invalidRows = Object.values(invalidByReason).reduce((sum, count) => sum + count, 0);
  return {
    audit: {
      rawRows: rows.length,
      validRows: valid.length,
      dedupedRows: deduped.rows.length,
      duplicateRows: deduped.duplicateRows,
      conflictingDuplicateKeys: deduped.conflictingDuplicateKeys,
      exactDuplicateKey: ['exchange', 'regime', 'selected_at'],
      invalidRows,
      invalidByReason,
      outOfWindowRows: deduped.rows.length - inWindow.length,
      duplicateSymbols: inWindow.reduce((sum, item) => sum + item.duplicateSymbols, 0),
      invalidSelectedSymbolEntries: inWindow.reduce((sum, item) => sum + item.invalidSymbolEntries, 0),
      invalidSelectionScores: inWindow.reduce((sum, item) => sum + item.invalidSelectionScores, 0),
      universeSizeMismatches: inWindow.filter((item) => item.anomalyReasons.includes('universeSizeMismatch')).length,
      invalidAxisWeightRows: inWindow.filter((item) => item.anomalyReasons.includes('invalidAxisWeightContract')).length,
      notShadowOnlyRows: inWindow.filter((item) => item.anomalyReasons.includes('notShadowOnly')).length,
    },
    recent,
    previous,
    comparison: {
      status: comparisonStatus,
      observationCountDelta: recent.rows - previous.rows,
      observationCountDirection: comparisonStatus === 'sufficient'
        ? recent.rows > previous.rows ? 'up' : recent.rows < previous.rows ? 'down' : 'flat'
        : 'insufficient',
      meanUniverseSizeDelta: comparisonStatus === 'sufficient' && recent.meanUniverseSize != null && previous.meanUniverseSize != null
        ? round(recent.meanUniverseSize - previous.meanUniverseSize)
        : null,
    },
    latestByExchange,
    selectionChanges: selectionChangeAudit(inWindow, window.recent.start),
    gaps: {
      timeZone: TIME_ZONE,
      expectedRefreshLocalTime: UNIVERSE_REFRESH_LOCAL_TIME,
      expectedDates,
      observedDates: actualDates,
      missingDates: expectedDates.filter((date) => !actualDates.includes(date)),
      byExchange,
    },
  };
}

function boundaryChecklist(bridge, universe) {
  const comparisonSufficient = bridge.comparison.status === 'sufficient' && universe.comparison.status === 'sufficient';
  const invalidRows = bridge.audit.invalidRows + universe.audit.invalidRows;
  return [
    {
      check: 'unit_contract',
      status: universe.audit.invalidAxisWeightRows + universe.audit.invalidSelectionScores === 0 ? 'pass' : 'attention',
      evidence: 'bridge rates use ratio_0_1, bridge volume uses events_per_kst_day, universe axis weights and selection scores use ratio_0_1',
    },
    {
      check: 'duplicate_key',
      status: bridge.audit.conflictingDuplicateKeys + universe.audit.conflictingDuplicateKeys === 0 ? 'pass' : 'attention',
      evidence: { bridge: bridge.audit.exactDuplicateKey, universe: universe.audit.exactDuplicateKey },
    },
    {
      check: 'outlier_isolation',
      status: 'pass',
      evidence: bridge.dailyVolume.outlierAudit.method,
    },
    {
      check: 'direction',
      status: comparisonSufficient ? 'pass' : 'insufficient',
      evidence: { bridge: bridge.comparison.eventCountDirection, universe: universe.comparison.observationCountDirection },
    },
    {
      check: 'partial_event',
      status: 'pass',
      evidence: `${invalidRows} invalid or incomplete rows isolated before aggregation`,
    },
    {
      check: 'concurrency',
      status: 'pass',
      evidence: 'one static UNION ALL SELECT provides one PostgreSQL statement snapshot; duplicate winners use highest id',
    },
    {
      check: 'initial_state',
      status: bridge.audit.rawRows + universe.audit.rawRows > 0 ? 'pass' : 'insufficient',
      evidence: 'empty inputs return explicit insufficient sections without synthesized observations',
    },
    {
      check: 'raw_sample',
      status: bridge.audit.rawRows > 0 && universe.audit.rawRows > 0 ? 'pass' : 'insufficient',
      evidence: { bridgeRows: bridge.audit.rawRows, universeRows: universe.audit.rawRows },
    },
    {
      check: 'date_time_contract',
      status: bridge.audit.invalidByReason.invalidObservedAt + universe.audit.invalidByReason.invalidSelectedAt === 0 ? 'pass' : 'attention',
      evidence: 'TIMESTAMPTZ Date accepted directly; missing, malformed, and non-existent calendar timestamps are isolated without fallback',
    },
  ];
}

export function buildLunaPhase5BridgeUniverseReport(bridgeRows, universeRows, options = {}) {
  const asOf = options.asOf ?? new Date();
  const window = buildWindow(asOf);
  const normalizedOptions = {
    minPeriodRows: Math.max(1, Number(options.minPeriodRows) || DEFAULT_MIN_PERIOD_ROWS),
    outlierMinGroupN: Math.max(3, Number(options.outlierMinGroupN) || DEFAULT_OUTLIER_MIN_GROUP_N),
  };
  const bridge = buildBridgeReport(Array.isArray(bridgeRows) ? bridgeRows : [], window, normalizedOptions);
  const universe = buildUniverseReport(Array.isArray(universeRows) ? universeRows : [], window, normalizedOptions);
  const checklist = boundaryChecklist(bridge, universe);
  const summary = `P5-C3 bridge ${bridge.recent.rows}/${bridge.previous.rows} recent/previous events (${bridge.comparison.eventCountDirection}); bridge anomalies ${bridge.anomalies.rows}, daily volume outliers ${bridge.dailyVolume.outlierDays.length}; universe ${universe.recent.rows}/${universe.previous.rows} observations, ${universe.selectionChanges.changedTransitions}/${universe.selectionChanges.transitions} changed transitions, ${universe.gaps.missingDates.length}/${universe.gaps.expectedDates.length} KST refresh dates missing; sample gates bridge=${bridge.comparison.status}, universe=${universe.comparison.status}.`;
  return {
    generatedAt: window.recent.end.toISOString(),
    contract: {
      readOnly: true,
      sqlMode: 'single_static_select_statement_snapshot',
      relations: [
        'investment.luna_phase5_mcp_a2a_bridge_shadow',
        'investment.universe_selection_shadow',
      ],
      timeZone: TIME_ZONE,
      comparisonWindowDays: 7,
      universeRefreshLocalTime: UNIVERSE_REFRESH_LOCAL_TIME,
      timestampDriverContract: 'TIMESTAMPTZ -> Date',
      minPeriodRows: normalizedOptions.minPeriodRows,
    },
    window: {
      previous: {
        start: window.previous.start.toISOString(),
        end: window.previous.end.toISOString(),
      },
      recent: {
        start: window.recent.start.toISOString(),
        end: window.recent.end.toISOString(),
      },
    },
    bridge,
    universe,
    boundaryChecklist: checklist,
    summary,
  };
}

function splitTaggedRows(rows) {
  const bridgeRows = [];
  const universeRows = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.source_kind === 'bridge') {
      bridgeRows.push({
        id: row.source_id,
        observed_at: row.event_at,
        skill_id: row.skill_id,
        mcp_tool_name: row.mcp_tool_name,
        status: row.bridge_status,
        direct_trade_allowed: row.direct_trade_allowed,
        protected_policy: row.protected_policy,
        capability: row.capability,
        evidence: row.evidence,
      });
    } else if (row.source_kind === 'universe') {
      universeRows.push({
        id: row.source_id,
        selected_at: row.event_at,
        regime: row.regime,
        exchange: row.exchange,
        axis_weights: row.axis_weights,
        selected_symbols: row.selected_symbols,
        universe_size: row.universe_size,
        shadow_only: row.shadow_only,
      });
    }
  }
  return { bridgeRows, universeRows };
}

export async function runLunaPhase5BridgeUniverseReport(options = {}, deps = {}) {
  const asOf = options.asOf ?? new Date();
  const window = buildWindow(asOf);
  const queryFn = deps.query || db.query;
  const rows = await queryFn(BRIDGE_UNIVERSE_WEEKLY_REPORT_SQL, [window.previous.start, window.recent.end]);
  const { bridgeRows, universeRows } = splitTaggedRows(rows);
  return buildLunaPhase5BridgeUniverseReport(bridgeRows, universeRows, { ...options, asOf: window.recent.end });
}

function parseArgs(argv = process.argv.slice(2)) {
  const asOfText = argv.find((arg) => arg.startsWith('--as-of='))?.slice('--as-of='.length);
  const minRowsText = argv.find((arg) => arg.startsWith('--min-period-rows='))?.split('=')[1];
  const asOf = asOfText ? parseLunaReportTimestamp(asOfText) : new Date();
  if (!asOf) throw new Error('invalid --as-of timestamp; use an existing ISO calendar instant with timezone');
  return {
    json: argv.includes('--json'),
    asOf,
    minPeriodRows: Math.max(1, Number(minRowsText) || DEFAULT_MIN_PERIOD_ROWS),
  };
}

async function main() {
  const options = parseArgs();
  const report = await runLunaPhase5BridgeUniverseReport(options);
  if (!options.json) console.log(report.summary);
  console.log(JSON.stringify(report, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna phase5 bridge/universe report failed:',
  });
}
