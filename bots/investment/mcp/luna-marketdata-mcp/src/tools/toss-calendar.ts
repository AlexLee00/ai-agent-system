import { getBrokerAdapter } from '../../../../shared/brokers/broker-router.ts';

type TossToolArgs = {
  market?: string;
  date?: string;
  [key: string]: unknown;
};

function safeError(error: unknown) {
  return String(error instanceof Error ? error.message : error || 'unknown_error').slice(0, 280);
}

export async function getTossMarketCalendar(args: TossToolArgs = {}) {
  const market = String(args.market || 'domestic').trim();
  try {
    const calendar = await getBrokerAdapter('toss').getMarketCalendar?.(market, args);
    return { ok: Boolean(calendar), source: 'toss_openapi', advisoryOnly: true, market, calendar };
  } catch (error) {
    return { ok: false, source: 'toss_openapi', advisoryOnly: true, market, calendar: null, error: safeError(error) };
  }
}
