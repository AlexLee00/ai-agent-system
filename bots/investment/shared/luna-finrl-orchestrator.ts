// @ts-nocheck
/**
 * Luna FinRL-X Orchestrator
 *
 * Python FinRL-X 4-layer와 Node.js 루나 시스템 브릿지
 * 매주 일요일 02:00 학습 실행 (launchd)
 *
 * Layer 1: Market Environments (Bull/Bear/Sideways/Volatile)
 * Layer 2: Agent Pool (15 에이전트 → DRL)
 * Layer 3: Strategy Evolution (자율 mutation)
 * Layer 4: Performance Optimization
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db/core.ts';
import { buildWeeklyLearningReport } from './luna-self-rewarding-engine.ts';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = process.env.PROJECT_ROOT || path.resolve(INVESTMENT_ROOT, '../..');
const DEFAULT_PYTHON_BIN = existsSync('/opt/homebrew/bin/python3') ? '/opt/homebrew/bin/python3' : 'python3';
const PYTHON_BIN = process.env.LUNA_PYTHON_BIN || DEFAULT_PYTHON_BIN;
const FINRL_DIR = path.join(PROJECT_ROOT, 'bots/investment/python/finrl-x');

// ─── 타입 ────────────────────────────────────────────────────

export interface FinRLTrainingResult {
  market: string;
  layer: number;
  success: boolean;
  output?: string;
  error?: string;
  durationMs: number;
}

export interface WeeklyTrainingResult {
  market: string;
  layers: FinRLTrainingResult[];
  totalDurationMs: number;
  overallSuccess: boolean;
  learningReport?: object;
}

// ─── 레이어별 실행 ───────────────────────────────────────────

async function runPythonLayer(scriptName: string, args: string[] = []): Promise<FinRLTrainingResult> {
  const scriptPath = path.join(FINRL_DIR, scriptName);
  const start = Date.now();
  const market = args.find((_, i) => args[i - 1] === '--market') ?? 'crypto';

  try {
    const { stdout, stderr } = await execFileAsync(
      PYTHON_BIN,
      [scriptPath, ...args],
      { timeout: 30 * 60 * 1000 }  // 30분 타임아웃
    );

    if (stderr && !stdout) {
      console.warn(`[FinRL] ${scriptName} stderr:`, stderr.slice(0, 500));
    }

    return {
      market,
      layer: parseInt(scriptName.replace(/[^0-9]/g, '').charAt(0) ?? '0'),
      success: true,
      output: stdout.slice(0, 2000),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      market,
      layer: parseInt(scriptName.replace(/[^0-9]/g, '').charAt(0) ?? '0'),
      success: false,
      error: err?.message?.slice(0, 500),
      durationMs: Date.now() - start,
    };
  }
}

// ─── 전체 학습 파이프라인 ─────────────────────────────────────

export async function runWeeklyFinRLTraining(market: string = 'crypto'): Promise<WeeklyTrainingResult> {
  console.log(`[FinRL] 주간 학습 시작 — market=${market}`);
  const start = Date.now();

  const layers: FinRLTrainingResult[] = [];

  // Layer 3: 전략 진화 (DB 기반 — Python 스크립트)
  console.log('[FinRL] Layer 3: 전략 진화...');
  const l3 = await runPythonLayer('layer3-strategy-evolution.py', ['--market', market]);
  layers.push(l3);
  if (!l3.success) {
    console.warn('[FinRL] Layer 3 실패 — 계속 진행');
  }

  // Layer 4: 성과 최적화
  console.log('[FinRL] Layer 4: 성과 최적화...');
  const l4 = await runPythonLayer('layer4-performance-opt.py', ['--market', market]);
  layers.push(l4);

  // Self-Rewarding 주간 리포트
  let learningReport;
  try {
    learningReport = await buildWeeklyLearningReport(market);
    console.log(`[FinRL] 주간 학습 리포트: velocity=${learningReport.learningVelocity}, experts=${learningReport.expertAgents.length}`);
  } catch (err) {
    console.warn('[FinRL] 주간 리포트 생성 실패:', err?.message);
  }

  // 결과 DB 기록
  await recordTrainingResult(layers, market, learningReport);

  const overallSuccess = layers.some(l => l.success);
  const totalDurationMs = Date.now() - start;

  console.log(`[FinRL] 완료 — ${totalDurationMs}ms, 성공=${overallSuccess}`);
  return { market, layers, totalDurationMs, overallSuccess, learningReport };
}

// ─── 실시간 레짐 환경 선택 ────────────────────────────────────

export async function selectCurrentRegimeEnv(market: string): Promise<string> {
  try {
    const res = await db.query(`
      SELECT evidence_snapshot->>'regime' AS regime, COUNT(*) AS cnt
      FROM investment.position_signal_history
      WHERE market = $1 AND created_at >= NOW() - INTERVAL '24 hours'
        AND evidence_snapshot->>'regime' IS NOT NULL
      GROUP BY evidence_snapshot->>'regime'
      ORDER BY cnt DESC
      LIMIT 1
    `, [market]);

    return res.rows[0]?.regime ?? 'sideways';
  } catch (_err) {
    return 'sideways';
  }
}

// ─── DB 기록 ────────────────────────────────────────────────

async function recordTrainingResult(
  layers: FinRLTrainingResult[],
  market: string,
  learningReport?: object
): Promise<void> {
  try {
    await db.query(`
      INSERT INTO investment.strategy_mutation_events (
        event_type, lifecycle_phase, position_scope_key, exchange, symbol, trade_mode,
        old_setup_type, validity_score, predictive_score, reason, metadata, created_at
      ) VALUES ('weekly_finrl_training', 'shadow', $1, 'learning', $2, 'shadow', $3, $4, $5, $6, $7::jsonb, NOW())
    `, [
      `finrl:${market}:weekly`,
      `${market}:portfolio`,
      `finrl:${market}`,
      layers.filter(l => l.success).length / Math.max(1, layers.length),
      (learningReport as any)?.learningVelocity ?? 0.5,
      `weekly FinRL/PPO shadow training result for ${market}`,
      JSON.stringify({ market, layers: layers.map(l => ({ layer: l.layer, success: l.success, durationMs: l.durationMs })), learningReport }),
    ]);
  } catch (_err) {
    // 기록 실패해도 학습 결과에 영향 X
  }
}
