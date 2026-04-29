// @ts-nocheck
import { query, run } from './core.ts';

export async function insertAnalysis({ symbol, analyst, signal, confidence, reasoning, metadata, exchange = 'binance' }) {
  await run(
    `INSERT INTO analysis (symbol, analyst, signal, confidence, reasoning, metadata, exchange)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [symbol, analyst, signal, confidence ?? null, reasoning ?? null,
     metadata ? JSON.stringify(metadata) : null, exchange],
  );
}

export async function getRecentAnalysis(symbol, minutesBack = 30, exchange = null) {
  if (exchange) {
    return query(
      `SELECT * FROM analysis
       WHERE symbol = $1 AND exchange = $2
         AND created_at > now() - INTERVAL '1 minute' * $3
       ORDER BY created_at DESC`,
      [symbol, exchange, minutesBack],
    );
  }
  return query(
    `SELECT * FROM analysis
     WHERE symbol = $1 AND created_at > now() - INTERVAL '1 minute' * $2
     ORDER BY created_at DESC`,
    [symbol, minutesBack],
  );
}
