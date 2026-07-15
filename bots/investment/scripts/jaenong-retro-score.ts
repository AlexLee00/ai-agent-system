#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { getOverseasDailyPriceBars } from '../shared/kis-client.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function round(value, digits = 4) {
  if (value == null || value === '') return null;
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function skewness(values) {
  if (values.length < 3) return null;
  const avg = mean(values);
  const variance = mean(values.map((value) => (value - avg) ** 2));
  if (!variance) return 0;
  const sd = Math.sqrt(variance);
  return round(mean(values.map((value) => ((value - avg) / sd) ** 3)));
}

function maxDrawdown(returns) {
  if (!returns.length) return null;
  let equity = 1;
  let peak = 1;
  let mdd = 0;
  for (const value of returns) {
    equity *= 1 + value / 100;
    peak = Math.max(peak, equity);
    mdd = Math.min(mdd, (equity / peak - 1) * 100);
  }
  return round(mdd);
}

function canonicalDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const match = String(value || '').match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function normalizeBars(bars = []) {
  return (Array.isArray(bars) ? bars : [])
    .filter((bar) => Number(bar?.close) > 0)
    .map((bar) => ({
      date: canonicalDate(bar.date || bar.timestamp),
      open: Number(bar.open || bar.close),
      high: Number(bar.high || bar.close),
      low: Number(bar.low || bar.close),
      close: Number(bar.close),
    }))
    .filter((bar) => bar.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function pointHit(bar, price) {
  return Number(bar.low) <= price && Number(bar.high) >= price;
}

function candidateRow(candidate, inputBars) {
  const publishedDate = canonicalDate(candidate.publishedAt);
  const bars = normalizeBars(inputBars)
    .filter((bar) => !publishedDate || bar.date >= publishedDate);
  const entryPrice = Number(candidate.buyPoints?.[0]?.price);
  const exitPrice = Number(candidate.sellPoints?.[0]?.price);
  const direction = candidate.direction === 'short' ? 'short' : 'long';
  const entryIndex = bars.findIndex((bar) => pointHit(bar, entryPrice));
  const entryHit = entryIndex >= 0;
  const afterEntry = entryHit ? bars.slice(entryIndex + 1) : [];
  const exitOffset = Number.isFinite(exitPrice) && exitPrice > 0
    ? afterEntry.findIndex((bar) => pointHit(bar, exitPrice))
    : -1;
  const exitHit = entryHit && exitOffset >= 0;
  const signedReturn = (price) => round((direction === 'short' ? entryPrice - price : price - entryPrice) / entryPrice * 100);
  const holdingReturns = {};
  for (const days of [1, 5, 20]) {
    const bar = entryHit ? bars[entryIndex + days] : null;
    holdingReturns[`day${days}`] = bar ? signedReturn(bar.close) : null;
  }
  const entryBar = entryHit ? bars[entryIndex] : null;
  const previousBar = entryHit ? bars[entryIndex - 1] : null;
  const gapPct = entryBar && previousBar ? round((entryBar.open - previousBar.close) / previousBar.close * 100) : null;
  const intradayPct = entryBar ? round((entryBar.low - entryBar.open) / entryBar.open * 100) : null;
  return {
    ticker: candidate.ticker,
    sourcePostId: candidate.sourcePostId || null,
    publishedAt: candidate.publishedAt || null,
    available: candidate.available === true,
    entryPrice,
    exitPrice: Number.isFinite(exitPrice) ? exitPrice : null,
    entryHit,
    entryDate: entryBar?.date || null,
    exitHit,
    exitDate: exitHit ? afterEntry[exitOffset]?.date || null : null,
    hypotheticalReturn: exitHit ? signedReturn(exitPrice) : null,
    holdingReturns,
    adverseSelection: entryHit ? {
      gapPct,
      intradayPct,
      gapDown: gapPct != null && gapPct <= -3,
      crashDay: intradayPct != null && intradayPct <= -5,
    } : null,
    unavailableReasons: candidate.unavailableReasons || [],
  };
}

function adjustmentClusterKey(row) {
  const date = row.publishedAt ? new Date(row.publishedAt) : null;
  if (!date || Number.isNaN(date.getTime())) return 'unknown';
  const weekStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - date.getUTCDay()));
  return weekStart.toISOString().slice(0, 10);
}

export function scoreJaenongCandidates(candidates = [], barsByTicker = {}) {
  const rows = (Array.isArray(candidates) ? candidates : []).map((candidate) => (
    candidate.available === true && canonicalDate(candidate.publishedAt)
      ? candidateRow(
          candidate,
          barsByTicker[`${candidate.ticker}:${candidate.sourcePostId}`] || barsByTicker[candidate.ticker] || [],
        )
      : {
          ticker: candidate.ticker || null,
          sourcePostId: candidate.sourcePostId || null,
          publishedAt: candidate.publishedAt || null,
          available: false,
          entryHit: false,
          exitHit: false,
          hypotheticalReturn: null,
          holdingReturns: { day1: null, day5: null, day20: null },
          adverseSelection: null,
          unavailableReasons: candidate.available === true
            ? [...new Set([...(candidate.unavailableReasons || []), 'published_at_invalid'])]
            : candidate.unavailableReasons || ['candidate_unavailable'],
        }
  ));
  const available = rows.filter((row) => row.available);
  const entryHits = available.filter((row) => row.entryHit);
  const returns = rows.map((row) => row.hypotheticalReturn).filter(Number.isFinite);
  const chronologicalReturns = rows
    .filter((row) => Number.isFinite(row.hypotheticalReturn))
    .toSorted((a, b) => String(a.publishedAt || '').localeCompare(String(b.publishedAt || '')))
    .map((row) => row.hypotheticalReturn);
  const unavailableReasonDistribution = {};
  rows.forEach((row) => (row.unavailableReasons || []).forEach((reason) => {
    unavailableReasonDistribution[reason] = (unavailableReasonDistribution[reason] || 0) + 1;
  }));
  const clusters = {};
  rows.forEach((row) => {
    const key = adjustmentClusterKey(row);
    clusters[key] ||= { candidates: 0, entries: 0, exits: 0, returns: [] };
    clusters[key].candidates += 1;
    clusters[key].entries += Number(row.entryHit);
    clusters[key].exits += Number(row.exitHit);
    if (Number.isFinite(row.hypotheticalReturn)) clusters[key].returns.push(row.hypotheticalReturn);
  });
  const adjustmentClusters = Object.fromEntries(Object.entries(clusters).map(([key, value]) => [key, {
    candidates: value.candidates,
    entryHits: value.entries,
    exitHits: value.exits,
    averageReturn: round(mean(value.returns)),
  }]));
  return {
    summary: {
      totalCandidates: rows.length,
      availableCandidates: available.length,
      unavailableCandidates: rows.length - available.length,
      entryHitRate: available.length ? round(entryHits.length / available.length) : null,
      exitHitRateAfterEntry: entryHits.length ? round(entryHits.filter((row) => row.exitHit).length / entryHits.length) : null,
      averageHypotheticalReturn: round(mean(returns)),
      skewness: skewness(returns),
      maxDrawdownPct: maxDrawdown(chronologicalReturns),
      adverseGapCount: entryHits.filter((row) => row.adverseSelection?.gapDown).length,
      crashDayCount: entryHits.filter((row) => row.adverseSelection?.crashDay).length,
      unavailableReasonDistribution,
      adjustmentClusters,
    },
    rows,
  };
}

export async function scoreStoredJaenongPosts(options = {}, deps = {}) {
  const queryFn = deps.queryFn || db.query;
  const runFn = deps.runFn || db.run;
  const getBars = deps.getBars || getOverseasDailyPriceBars;
  const stored = await queryFn(
    `SELECT s.id AS score_id, s.post_id, s.parser_version, s.brief,
            p.source_post_id, p.published_at
       FROM investment.jaenong_post_scores s
       JOIN investment.jaenong_posts p ON p.id = s.post_id
      ORDER BY p.published_at DESC NULLS LAST, s.id DESC
      LIMIT $1`,
    [Math.max(1, Number(options.limit || 100) || 100)],
  );
  const candidates = stored.flatMap((row) => (row.brief?.candidates || []).map((candidate) => ({
    ...candidate,
    sourcePostId: row.source_post_id,
    publishedAt: row.published_at,
    scoreId: row.score_id,
  })));
  const barsByTicker = {};
  const barCache = new Map();
  for (const candidate of candidates.filter((item) => item.available)) {
    const published = new Date(candidate.publishedAt);
    if (Number.isNaN(published.getTime())) continue;
    const windowEnd = new Date(Math.min(Date.now(), published.getTime() + 45 * 24 * 60 * 60 * 1000));
    const endDate = windowEnd.toISOString().slice(0, 10).replaceAll('-', '');
    const cacheKey = `${candidate.ticker}:${endDate}`;
    if (!barCache.has(cacheKey)) {
      barCache.set(cacheKey, await getBars(candidate.ticker, { days: 90, endDate }).catch(() => []));
    }
    barsByTicker[`${candidate.ticker}:${candidate.sourcePostId}`] = barCache.get(cacheKey);
  }
  const result = scoreJaenongCandidates(candidates, barsByTicker);
  if (options.write === true) {
    for (const row of stored) {
      const ownResult = scoreJaenongCandidates(
        candidates.filter((item) => item.sourcePostId === row.source_post_id),
        barsByTicker,
      );
      await runFn(
        `UPDATE investment.jaenong_post_scores
            SET score_summary = $1::jsonb, score_rows = $2::jsonb, scored_at = now()
          WHERE id = $3`,
        [JSON.stringify(ownResult.summary), JSON.stringify(ownResult.rows), row.score_id],
      );
    }
  }
  return result;
}

if (isDirectExecution(import.meta.url)) {
  const argv = process.argv.slice(2);
  void runCliMain({
    run: () => scoreStoredJaenongPosts({
      write: argv.includes('--write'),
      limit: Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || 100),
    }),
    onSuccess: (result) => console.log(JSON.stringify({ ok: true, write: argv.includes('--write'), ...result }, null, 2)),
    errorPrefix: 'jaenong retro score failed:',
  });
}
