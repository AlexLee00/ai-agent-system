import { getBrokerAdapter } from '../../../../shared/brokers/broker-router.ts';

type TossToolArgs = {
  symbol?: string;
  count?: number | string;
  limit?: number | string;
  [key: string]: unknown;
};

function safeError(error: unknown) {
  return String(error instanceof Error ? error.message : error || 'unknown_error').slice(0, 280);
}

export async function getTossTrades(args: TossToolArgs = {}) {
  const symbol = String(args.symbol || '005930').trim().toUpperCase();
  try {
    const trades = await getBrokerAdapter('toss').getTrades(symbol, args);
    return { ok: true, source: 'toss_openapi', advisoryOnly: true, readOnly: true, symbol, trades };
  } catch (error) {
    return { ok: false, source: 'toss_openapi', advisoryOnly: true, readOnly: true, symbol, trades: [], error: safeError(error) };
  }
}
