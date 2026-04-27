import kst = require('./kst');
import env = require('./env');
import pgPool = require('./pg-pool');

type PricingEntry = {
  input: number;
  output: number;
  free: boolean;
};

type TrackTokensInput = {
  bot: string;
  team: string;
  model: string;
  provider?: string;
  taskType?: string;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  costUsd?: number;
};

type SummaryRow = {
  bot_name: string;
  team: string;
  model: string;
  provider: string | null;
  is_free: boolean | number;
  task_type?: string;
  total_in?: string | number;
  total_out?: string | number;
  total_tokens?: string | number;
  total_cost?: string | number;
  call_count?: string | number;
};

const DEV_HUB_READONLY = env.IS_DEV && !!env.HUB_BASE_URL && !process.env.PG_DIRECT;
const SCHEMA = 'claude';

const PRICING: Record<string, PricingEntry> = {
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, free: false },
  'claude-opus-4-6': { input: 15.0, output: 75.0, free: false },
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0, free: false },
  'claude-code/sonnet': { input: 3.0, output: 15.0, free: false },
  'claude-code/opus': { input: 15.0, output: 75.0, free: false },
  'meta-llama/llama-4-scout-17b-16e-instruct': { input: 0, output: 0, free: true },
  'gemini-oauth/gemini-2.5-flash': { input: 0, output: 0, free: true },
  'google-gemini-cli/gemini-2.5-flash': { input: 0, output: 0, free: true },
  'gemini-2.5-flash': { input: 0, output: 0, free: true },
  'groq/llama-3.1-8b-instant': { input: 0, output: 0, free: true },
  'gpt-4o': { input: 2.5, output: 10.0, free: false },
  'gpt-4o-mini': { input: 0.15, output: 0.6, free: false },
};

function parseNumber(value: string | number | undefined): number {
  return Number(value || 0);
}

function formatCost(row: SummaryRow): string {
  return `$${(parseFloat(String(row.total_cost || 0)) || 0).toFixed(4)}`;
}

function isFreeModel(row: SummaryRow): boolean {
  return row.is_free === true || row.is_free === 1;
}

export async function trackTokens({
  bot,
  team,
  model,
  provider,
  taskType = 'unknown',
  tokensIn = 0,
  tokensOut = 0,
  durationMs = 0,
  costUsd,
}: TrackTokensInput): Promise<void> {
  if (DEV_HUB_READONLY) return;
  try {
    const pricing = PRICING[model] || { input: 0, output: 0, free: false };
    const isFree = pricing.free || provider === 'groq' || provider === 'google' || provider === 'gemini-oauth';
    const cost = costUsd !== undefined
      ? costUsd
      : ((tokensIn * pricing.input) + (tokensOut * pricing.output)) / 1_000_000;

    await pgPool.run(
      SCHEMA,
      `
      INSERT INTO token_usage
        (bot_name, team, model, provider, is_free, task_type, tokens_in, tokens_out, cost_usd, duration_ms, date_kst)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `,
      [bot, team, model, provider, isFree ? 1 : 0, taskType, tokensIn, tokensOut, cost, durationMs, kst.today()],
    );
  } catch (error) {
    console.warn(`[token-tracker] 기록 실패 (${bot}): ${(error as Error).message}`);
  }
}

export async function getDailySummary(dateKst?: string): Promise<SummaryRow[]> {
  const date = dateKst || kst.today();
  return pgPool.query(
    SCHEMA,
    `
    SELECT
      bot_name, team, model, provider, is_free, task_type,
      SUM(tokens_in)::integer              AS total_in,
      SUM(tokens_out)::integer             AS total_out,
      SUM(tokens_in + tokens_out)::integer AS total_tokens,
      SUM(cost_usd)::float                 AS total_cost,
      COUNT(*)::integer                    AS call_count
    FROM token_usage
    WHERE date_kst = $1
    GROUP BY bot_name, team, model, provider, is_free, task_type
    ORDER BY total_tokens DESC
  `,
    [date],
  ) as Promise<SummaryRow[]>;
}

export async function getMonthlySummary(monthKst?: string): Promise<SummaryRow[]> {
  const month = monthKst || kst.today().slice(0, 7);
  return pgPool.query(
    SCHEMA,
    `
    SELECT
      bot_name, team, model, provider, is_free,
      SUM(tokens_in + tokens_out)::integer AS total_tokens,
      SUM(cost_usd)::float                 AS total_cost,
      COUNT(*)::integer                    AS call_count
    FROM token_usage
    WHERE date_kst LIKE $1
    GROUP BY bot_name, team, model, provider, is_free
    ORDER BY total_cost DESC, total_tokens DESC
  `,
    [`${month}%`],
  ) as Promise<SummaryRow[]>;
}

export async function buildCostReport(): Promise<string> {
  const today = kst.today();
  const month = today.slice(0, 7);
  const daily = await getDailySummary(today);
  const monthly = await getMonthlySummary(month);

  const todayCostUsd = daily.reduce((sum, row) => sum + (parseFloat(String(row.total_cost || 0)) || 0), 0);
  const todayTokens = daily.reduce((sum, row) => sum + parseNumber(row.total_tokens), 0);
  const monthCostUsd = monthly.reduce((sum, row) => sum + (parseFloat(String(row.total_cost || 0)) || 0), 0);
  const monthTokens = monthly.reduce((sum, row) => sum + parseNumber(row.total_tokens), 0);

  const lines = [
    '💰 LLM 토큰 리포트',
    '',
    `📅 오늘 (${today})`,
    `  총 토큰: ${todayTokens.toLocaleString()}`,
    `  유료 비용: $${todayCostUsd.toFixed(4)}`,
  ];

  if (daily.length > 0) {
    lines.push('', '  봇별:');
    for (const row of daily.slice(0, 6)) {
      const tag = isFreeModel(row) ? '무료' : formatCost(row);
      lines.push(`  • ${row.bot_name} [${row.task_type}] ${parseNumber(row.total_tokens).toLocaleString()}tok (${tag})`);
    }
  }

  lines.push(
    '',
    `📆 이번 달 (${month})`,
    `  총 토큰: ${monthTokens.toLocaleString()}`,
    `  유료 비용: $${monthCostUsd.toFixed(4)}`,
  );

  if (monthly.length > 0) {
    lines.push('', '  모델별:');
    for (const row of monthly.slice(0, 5)) {
      const tag = isFreeModel(row) ? '무료' : formatCost(row);
      lines.push(`  • ${row.bot_name} (${row.model.split('/').pop()}) ${parseNumber(row.total_tokens).toLocaleString()}tok ${tag}`);
    }
  }

  return lines.join('\n');
}
