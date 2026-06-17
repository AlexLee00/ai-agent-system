import { getBrokerAdapter } from '../../../../shared/brokers/broker-router.ts';

type TossToolArgs = {
  symbol?: string;
  market?: string;
  interval?: string;
  range?: number | string;
  count?: number | string;
  [key: string]: unknown;
};

function safeError(error: unknown) {
  return String(error instanceof Error ? error.message : error || 'unknown_error').slice(0, 280);
}

export async function getTossCandles(args: TossToolArgs = {}) {
  const symbol = String(args.symbol || '005930').trim().toUpperCase();
  const market = String(args.market || '').trim() || symbol;
  const interval = String(args.interval || '1d');
  const range = args.range || args.count || 100;
  try {
    const candles = await getBrokerAdapter('toss').getCandles(symbol, interval, range, { ...args, market });
    return { ok: candles.length > 0, source: 'toss_openapi', advisoryOnly: true, symbol, market, interval, candles };
  } catch (error) {
    return { ok: false, source: 'toss_openapi', advisoryOnly: true, symbol, market, interval, candles: [], error: safeError(error) };
  }
}
