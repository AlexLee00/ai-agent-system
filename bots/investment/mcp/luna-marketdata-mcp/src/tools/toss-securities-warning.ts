import { getBrokerAdapter } from '../../../../shared/brokers/broker-router.ts';

type TossToolArgs = {
  symbol?: string;
  market?: string;
  [key: string]: unknown;
};

function safeError(error: unknown) {
  return String(error instanceof Error ? error.message : error || 'unknown_error').slice(0, 280);
}

export async function getTossSecuritiesWarning(args: TossToolArgs = {}) {
  const symbol = String(args.symbol || '005930').trim().toUpperCase();
  try {
    const warnings = await getBrokerAdapter('toss').getSecuritiesWarning?.(symbol, args.market || symbol, args);
    return { ok: true, source: 'toss_openapi', advisoryOnly: true, symbol, warnings: Array.isArray(warnings) ? warnings : [] };
  } catch (error) {
    return { ok: false, source: 'toss_openapi', advisoryOnly: true, symbol, warnings: [], error: safeError(error) };
  }
}
