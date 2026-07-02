import { getBrokerAdapter } from '../../../../shared/brokers/broker-router.ts';

type TossToolArgs = {
  symbol?: string;
  market?: string;
  depth?: number | string;
  [key: string]: unknown;
};

function safeError(error: unknown) {
  return String(error instanceof Error ? error.message : error || 'unknown_error').slice(0, 280);
}

export async function getTossOrderBook(args: TossToolArgs = {}) {
  const symbol = String(args.symbol || '005930').trim().toUpperCase();
  try {
    const orderbook = await getBrokerAdapter('toss').getOrderBook(symbol, args);
    return { ok: true, source: 'toss_openapi', advisoryOnly: true, readOnly: true, symbol, orderbook };
  } catch (error) {
    return { ok: false, source: 'toss_openapi', advisoryOnly: true, readOnly: true, symbol, error: safeError(error) };
  }
}
