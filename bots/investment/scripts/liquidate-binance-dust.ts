// @ts-nocheck
/**
 * scripts/liquidate-binance-dust.ts
 *
 * 목적:
 *   - 바이낸스 현물 지갑의 dust/watch 잔량(< 기본 10 USDT)을 실제로 정리
 *   - 우선순위: Convert → USDT, 실패 시 Convert → BNB, 마지막으로 시장가 매도
 *   - 의미 있는 실포지션/오픈 저널은 건드리지 않음
 *
 * 예시:
 *   node scripts/liquidate-binance-dust.ts --dry-run
 *   node scripts/liquidate-binance-dust.ts --max-usdt=10
 */

import ccxt from 'ccxt';
import * as db from '../shared/db.ts';
import { initHubSecrets, loadSecrets } from '../shared/secrets.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { syncPositionsAtMarketOpen } from '../shared/position-sync.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const DEFAULT_MAX_USDT = 10;
const EPSILON = 0.000001;

function parseArgs(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const maxUsdtArg = argv.find((arg) => arg.startsWith('--max-usdt='));
  const maxUsdt = Number(maxUsdtArg?.split('=')[1] || DEFAULT_MAX_USDT);
  return {
    dryRun,
    maxUsdt: Number.isFinite(maxUsdt) && maxUsdt > 0 ? maxUsdt : DEFAULT_MAX_USDT,
  };
}

export function getBinanceDustExchange() {
  const secrets = loadSecrets();
  return new ccxt.binance({
    apiKey: secrets.binance_api_key || '',
    secret: secrets.binance_api_secret || '',
    enableRateLimit: true,
    options: { defaultType: 'spot' },
  });
}

function precisionToDecimals(precision) {
  if (!(typeof precision === 'number') || !Number.isFinite(precision) || precision <= 0) return 8;
  if (precision >= 1) return 0;
  const decimals = Math.round(-Math.log10(precision));
  return Math.max(0, Math.min(12, decimals));
}

function formatConvertAmount(amount, precision) {
  const decimals = precisionToDecimals(precision);
  return Number(amount || 0).toFixed(decimals).replace(/0+$/u, '').replace(/\.$/u, '');
}

function summarizeExecution(result) {
  if (!result) return null;
  return {
    coin: result.coin,
    symbol: result.symbol || null,
    usdtValue: Number(result.usdtValue || 0),
    mode: result.mode,
    target: result.target || null,
    amount: result.amount || null,
    toAmount: result.toAmount || null,
    orderId: result.orderId || null,
    reason: result.reason || null,
  };
}

export async function buildDustCandidates(ex, maxUsdt) {
  await ex.loadMarkets();
  const [wallet, convertCurrencies, dbRows] = await Promise.all([
    ex.fetchBalance(),
    ex.fetchConvertCurrencies().catch(() => ({})),
    db.getAllPositions('binance', false).catch(() => []),
  ]);

  const meaningfulDbSymbols = new Set(
    dbRows
      .filter((row) =>
        Math.abs(Number(row.avg_price || 0)) > 0.0000001
        || Math.abs(Number(row.unrealized_pnl || 0)) > 0.0000001,
      )
      .map((row) => String(row.symbol || '').trim())
      .filter(Boolean),
  );

  const candidates = [];
  for (const [coin, totalRaw] of Object.entries(wallet?.total || {})) {
    const total = Number(totalRaw || 0);
    if (!(total > EPSILON)) continue;
    if (['info', 'free', 'used', 'total', 'debt', 'USDT', 'BNB'].includes(coin)) continue;

    const symbol = `${String(coin || '').trim().toUpperCase()}/USDT`;
    if (meaningfulDbSymbols.has(symbol)) continue;

    let ticker;
    let market;
    try {
      ticker = await ex.fetchTicker(symbol);
      market = ex.market(symbol);
    } catch {
      continue;
    }

    const last = Number(ticker?.last || 0);
    if (!(last > 0)) continue;

    const usdtValue = total * last;
    if (!(usdtValue > 0) || usdtValue >= maxUsdt) continue;

    let rounded = 0;
    try {
      rounded = Number(ex.amountToPrecision(symbol, total));
    } catch {
      rounded = 0;
    }
    const roundedUsdt = rounded * last;
    const minCost = Number(market?.limits?.cost?.min || 0);
    const minAmount = Number(market?.limits?.amount?.min || 0);
    const convertPrecision = convertCurrencies?.[coin]?.precision;
    const convertAmount = formatConvertAmount(total, convertPrecision);

    candidates.push({
      coin,
      symbol,
      total,
      rounded,
      last,
      usdtValue,
      roundedUsdt,
      minCost,
      minAmount,
      convertPrecision,
      convertAmount,
      sellable: rounded > 0 && roundedUsdt >= Math.max(minCost, 1),
    });
  }

  return candidates.sort((a, b) => b.usdtValue - a.usdtValue);
}

export async function buildBinanceDustSnapshot({ maxUsdt = DEFAULT_MAX_USDT } = {}) {
  await initHubSecrets().catch(() => false);
  await db.initSchema();

  const ex = getBinanceDustExchange();
  const candidates = await buildDustCandidates(ex, maxUsdt);
  const unresolved = [];
  const actionable = [];

  for (const candidate of candidates) {
    const preview = await executeDustCandidate(ex, candidate, true);
    const summarized = summarizeExecution(preview);
    if (preview.mode === 'unresolved') unresolved.push(summarized);
    else actionable.push(summarized);
  }

  const unresolvedTotalUsdt = unresolved.reduce((sum, row) => sum + Number(row.usdtValue || 0), 0);
  const actionableTotalUsdt = actionable.reduce((sum, row) => sum + Number(row.usdtValue || 0), 0);

  return {
    ok: true,
    maxUsdt,
    candidateCount: candidates.length,
    actionableCount: actionable.length,
    unresolvedCount: unresolved.length,
    actionableTotalUsdt: Number(actionableTotalUsdt.toFixed(8)),
    unresolvedTotalUsdt: Number(unresolvedTotalUsdt.toFixed(8)),
    actionableTop: actionable.slice(0, 10),
    unresolvedTop: unresolved.slice(0, 10),
  };
}

async function tryConvert(ex, candidate, target, dryRun) {
  const quote = await ex.fetchConvertQuote(candidate.coin, target, candidate.convertAmount);
  const quoteId = quote?.id || quote?.info?.quoteId;
  if (!quoteId) throw new Error('missing_convert_quote_id');

  if (dryRun) {
    return {
      coin: candidate.coin,
      symbol: candidate.symbol,
      usdtValue: candidate.usdtValue,
      mode: 'convert_dry_run',
      target,
      amount: candidate.convertAmount,
      toAmount: Number(quote?.toAmount || quote?.info?.toAmount || 0),
      orderId: quoteId,
    };
  }

  const execution = await ex.createConvertTrade(quoteId, candidate.coin, target, candidate.convertAmount);
  return {
    coin: candidate.coin,
    symbol: candidate.symbol,
    usdtValue: candidate.usdtValue,
    mode: 'convert',
    target,
    amount: candidate.convertAmount,
    toAmount: Number(execution?.toAmount || execution?.info?.toAmount || quote?.toAmount || 0),
    orderId: execution?.id || execution?.order || execution?.info?.orderId || quoteId,
  };
}

async function tryMarketSell(ex, candidate, dryRun) {
  if (!candidate.sellable) {
    throw new Error(`market_sell_not_available:${candidate.roundedUsdt.toFixed(4)}<${Math.max(candidate.minCost, 1)}`);
  }

  if (dryRun) {
    return {
      coin: candidate.coin,
      symbol: candidate.symbol,
      usdtValue: candidate.usdtValue,
      mode: 'market_sell_dry_run',
      target: 'USDT',
      amount: candidate.rounded,
      toAmount: candidate.roundedUsdt,
      orderId: null,
    };
  }

  const order = await ex.createOrder(candidate.symbol, 'market', 'sell', candidate.rounded);
  return {
    coin: candidate.coin,
    symbol: candidate.symbol,
    usdtValue: candidate.usdtValue,
    mode: 'market_sell',
    target: 'USDT',
    amount: candidate.rounded,
    toAmount: Number(order?.cost || (Number(order?.filled || candidate.rounded) * Number(order?.average || candidate.last || 0)) || 0),
    orderId: order?.id || null,
  };
}

async function executeDustCandidate(ex, candidate, dryRun) {
  const reasons = [];

  try {
    return await tryConvert(ex, candidate, 'USDT', dryRun);
  } catch (error) {
    reasons.push(`convert_usdt:${error.message}`);
  }

  try {
    return await tryConvert(ex, candidate, 'BNB', dryRun);
  } catch (error) {
    reasons.push(`convert_bnb:${error.message}`);
  }

  try {
    return await tryMarketSell(ex, candidate, dryRun);
  } catch (error) {
    reasons.push(`market_sell:${error.message}`);
  }

  return {
    coin: candidate.coin,
    symbol: candidate.symbol,
    usdtValue: candidate.usdtValue,
    mode: 'unresolved',
    target: null,
    amount: candidate.total,
    toAmount: 0,
    orderId: null,
    reason: reasons.join(' | '),
  };
}

async function main() {
  const { dryRun, maxUsdt } = parseArgs();
  await initHubSecrets().catch(() => false);
  await db.initSchema();

  const ex = getBinanceDustExchange();
  const candidates = await buildDustCandidates(ex, maxUsdt);
  const results = [];

  for (const candidate of candidates) {
    const result = await executeDustCandidate(ex, candidate, dryRun);
    results.push(result);
  }

  const converted = results.filter((row) => row.mode === 'convert' || row.mode === 'convert_dry_run');
  const sold = results.filter((row) => row.mode === 'market_sell' || row.mode === 'market_sell_dry_run');
  const unresolved = results.filter((row) => row.mode === 'unresolved');

  let syncResult = null;
  if (!dryRun) {
    syncResult = await syncPositionsAtMarketOpen('crypto').catch((error) => ({
      ok: false,
      error: error.message,
    }));
  }

  const payload = {
    dryRun,
    maxUsdt,
    candidateCount: candidates.length,
    convertedCount: converted.length,
    soldCount: sold.length,
    unresolvedCount: unresolved.length,
    unresolvedTop: unresolved.slice(0, 10).map(summarizeExecution),
  };

  const messageLines = [
    dryRun ? '🧪 [dust] 바이낸스 더스트 청산 드라이런' : '🧹 [dust] 바이낸스 더스트 청산 완료',
    `기준: < ${maxUsdt} USDT`,
    `대상 ${candidates.length}개`,
    `convert ${converted.length}개 / market sell ${sold.length}개 / unresolved ${unresolved.length}개`,
  ];
  if (syncResult?.ok) {
    messageLines.push(`포지션 동기화: broker ${syncResult.brokerPositionCount} / mismatch ${syncResult.mismatchCount}`);
  } else if (syncResult?.error) {
    messageLines.push(`포지션 동기화 실패: ${syncResult.error}`);
  }

  await publishAlert({
    from_bot: 'dust-liquidator',
    event_type: 'report',
    alert_level: unresolved.length > 0 ? 2 : 1,
    message: messageLines.join('\n'),
    payload,
  }).catch(() => {});

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    maxUsdt,
    candidates: candidates.map((row) => ({
      coin: row.coin,
      symbol: row.symbol,
      usdtValue: Number(row.usdtValue.toFixed(8)),
      sellable: row.sellable,
      convertAmount: row.convertAmount,
    })),
    results: results.map(summarizeExecution),
    syncResult,
  }, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ dust liquidation failed:',
  });
}
