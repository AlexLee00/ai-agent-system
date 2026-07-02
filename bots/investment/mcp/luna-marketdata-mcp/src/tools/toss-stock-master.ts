import { getBrokerAdapter } from '../../../../shared/brokers/broker-router.ts';

type TossToolArgs = {
  symbol?: string;
  market?: string;
  [key: string]: unknown;
};

function safeError(error: unknown) {
  return String(error instanceof Error ? error.message : error || 'unknown_error').slice(0, 280);
}

export async function getTossStockMaster(args: TossToolArgs = {}) {
  const symbol = String(args.symbol || '005930').trim().toUpperCase();
  try {
    const master = await getBrokerAdapter('toss').getStockMaster(symbol, args);
    return { ok: Boolean(master?.symbol), source: 'toss_openapi', advisoryOnly: true, readOnly: true, symbol, master };
  } catch (error) {
    return { ok: false, source: 'toss_openapi', advisoryOnly: true, readOnly: true, symbol, error: safeError(error) };
  }
}
