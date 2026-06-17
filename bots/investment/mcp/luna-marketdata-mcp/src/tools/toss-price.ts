import { getBrokerAdapter } from '../../../../shared/brokers/broker-router.ts';

type TossToolArgs = {
  symbol?: string;
  market?: string;
  [key: string]: unknown;
};

function safeError(error: unknown) {
  return String(error instanceof Error ? error.message : error || 'unknown_error').slice(0, 280);
}

export async function getTossPrice(args: TossToolArgs = {}) {
  const symbol = String(args.symbol || '005930').trim().toUpperCase();
  const market = String(args.market || '').trim() || symbol;
  try {
    const quote = await getBrokerAdapter('toss').getQuote(symbol, market, args);
    return { ok: Boolean(quote?.price), source: 'toss_openapi', advisoryOnly: true, symbol, market, quote };
  } catch (error) {
    return { ok: false, source: 'toss_openapi', advisoryOnly: true, symbol, market, error: safeError(error) };
  }
}
