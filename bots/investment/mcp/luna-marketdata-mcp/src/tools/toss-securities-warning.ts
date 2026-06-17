import { getBrokerAdapter } from '../../../../shared/brokers/broker-router.ts';

type TossToolArgs = {
  symbol?: string;
  symbols?: string[] | string;
  market?: string;
  [key: string]: unknown;
};

function safeError(error: unknown) {
  return String(error instanceof Error ? error.message : error || 'unknown_error').slice(0, 280);
}

export async function getTossSecuritiesWarning(args: TossToolArgs = {}) {
  const rawSymbols = Array.isArray(args.symbols)
    ? args.symbols
    : typeof args.symbols === 'string'
      ? args.symbols.split(',')
      : [];
  const symbols = rawSymbols.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean);
  if (symbols.length > 0) {
    try {
      const warnings = await getBrokerAdapter('toss').getSecuritiesWarningsForUniverse?.(symbols, args);
      return { ok: true, source: 'toss_openapi', advisoryOnly: true, symbols, warnings: Array.isArray(warnings) ? warnings : [] };
    } catch (error) {
      return { ok: false, source: 'toss_openapi', advisoryOnly: true, symbols, warnings: [], error: safeError(error) };
    }
  }

  const symbol = String(args.symbol || '').trim().toUpperCase();
  if (!symbol) {
    return { ok: false, source: 'toss_openapi', advisoryOnly: true, symbol: null, warnings: [], error: 'symbol_required' };
  }
  try {
    const warnings = await getBrokerAdapter('toss').getSecuritiesWarning?.(symbol, args.market || symbol, args);
    return { ok: true, source: 'toss_openapi', advisoryOnly: true, symbol, warnings: Array.isArray(warnings) ? warnings : [] };
  } catch (error) {
    return { ok: false, source: 'toss_openapi', advisoryOnly: true, symbol, warnings: [], error: safeError(error) };
  }
}
