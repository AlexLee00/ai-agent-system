'use strict';

/**
 * bots/blog/lib/autonomy-tracker.ts — Phase 추적 + 자율 진화 관리
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const { calculateAccuracy } = require('./feedback-learner.ts');

type AutonomyPhase = 1 | 2 | 3;

const PHASE_UP_THRESHOLD: Partial<Record<AutonomyPhase, number>> = { 1: 0.80, 2: 0.95 };
const PHASE_DOWN_THRESHOLD = 0.60;
const CONSECUTIVE_WEEKS_REQUIRED = 4;

type AutonomyHistoryRow = {
  accuracy: unknown;
  current_phase?: AutonomyPhase;
};

async function getPhaseHistory(weeks = 8) {
  try {
    return await pgPool.query('blog', `
      SELECT week_of, accuracy, current_phase, phase_changed
      FROM blog.autonomy_log
      ORDER BY week_of DESC
      LIMIT $1
    `, [weeks]) || [];
  } catch { return []; }
}

async function trackWeeklyAutonomy() {
  const accuracy = await calculateAccuracy(7);
  const history = await getPhaseHistory(CONSECUTIVE_WEEKS_REQUIRED);
  const currentPhase = (history[0]?.current_phase || 1) as AutonomyPhase;

  let newPhase = currentPhase;
  let phaseChanged = false;

  // Phase 상승 판단
  const upThreshold = PHASE_UP_THRESHOLD[currentPhase];
  if (upThreshold && currentPhase < 3) {
    const recentAccuracies = history.slice(0, CONSECUTIVE_WEEKS_REQUIRED - 1).map((h: AutonomyHistoryRow) => Number(h.accuracy));
    recentAccuracies.unshift(accuracy);
    if (recentAccuracies.length >= CONSECUTIVE_WEEKS_REQUIRED &&
        recentAccuracies.every((a: number) => a >= upThreshold)) {
      newPhase = (currentPhase + 1) as AutonomyPhase;
      phaseChanged = true;
    }
  }

  // Phase 하강 안전장치
  if (accuracy < PHASE_DOWN_THRESHOLD && currentPhase > 1) {
    newPhase = (currentPhase - 1) as AutonomyPhase;
    phaseChanged = true;
  }

  await pgPool.query('blog', `
    INSERT INTO blog.autonomy_log (week_of, accuracy, current_phase, phase_changed)
    VALUES (CURRENT_DATE, $1, $2, $3)
  `, [accuracy, newPhase, phaseChanged]);

  return { accuracy, previousPhase: currentPhase, currentPhase: newPhase, phaseChanged };
}

module.exports = { trackWeeklyAutonomy, getPhaseHistory };
