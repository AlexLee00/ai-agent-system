// @ts-nocheck
// ta-weighted-voting.ts — 다중 지표 가중치 투표 시스템 (Phase τ4)
// regime-aware 가중치로 여러 지표의 매수/매도/중립 신호 통합

function boolEnv(name, fallback = true) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function numEnv(name, fallback = 0) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

// ─── regime별 기본 가중치 ────────────────────────────────────────────

const REGIME_WEIGHTS = {
  TRENDING_BULL: {
    macd:              0.25,
    golden_cross:      0.20,
    divergence:        0.15,
    bollinger:         0.10,
    rsi:               0.10,
    volume:            0.10,
    pattern:           0.10,
    // 미사용 (합산시 정규화)
    death_cross:       0.00,
    stochastic:        0.00,
    atr:               0.00,
    support_resistance: 0.00,
  },
  TRENDING_BEAR: {
    macd:              0.25,
    death_cross:       0.20,
    divergence:        0.15,
    bollinger:         0.10,
    rsi:               0.10,
    volume:            0.10,
    pattern:           0.10,
    golden_cross:      0.00,
    stochastic:        0.00,
    atr:               0.00,
    support_resistance: 0.00,
  },
  VOLATILE: {
    bollinger:         0.30,
    rsi:               0.20,
    atr:               0.20,
    volume:            0.15,
    macd:              0.10,
    pattern:           0.05,
    golden_cross:      0.00,
    death_cross:       0.00,
    divergence:        0.00,
    stochastic:        0.00,
    support_resistance: 0.00,
  },
  RANGING: {
    rsi:               0.25,
    stochastic:        0.20,
    support_resistance: 0.20,
    bollinger:         0.15,
    macd:              0.10,
    volume:            0.10,
    golden_cross:      0.00,
    death_cross:       0.00,
    divergence:        0.00,
    atr:               0.00,
    pattern:           0.00,
  },
};

// ─── regime 매핑 ─────────────────────────────────────────────────────

function normalizeRegime(regime = 'RANGING') {
  const r = String(regime).toUpperCase();
  if (r.includes('BULL'))   return 'TRENDING_BULL';
  if (r.includes('BEAR'))   return 'TRENDING_BEAR';
  if (r.includes('VOLAT'))  return 'VOLATILE';
  return 'RANGING';
}

// ─── 투표 집계 ───────────────────────────────────────────────────────

/**
 * 여러 지표 투표를 regime-aware 가중치로 집계
 * @param {Array<{name:string, vote:-1|0|1, confidence?:number}>} votes
 * @param {string} regime
 * @returns {{ finalVote:-1|0|1, score:number, confidence:number, contributingIndicators:string[], detail:object }}
 */
export function aggregateVotes(votes = [], regime = 'RANGING') {
  const enabled = boolEnv('LUNA_TA_WEIGHTED_VOTING_ENABLED', true);
  if (!enabled || !votes.length) return { finalVote: 0, score: 0, confidence: 0, contributingIndicators: [], detail: {} };

  const regimeKey = normalizeRegime(regime);
  const baseWeights = REGIME_WEIGHTS[regimeKey] ?? REGIME_WEIGHTS.RANGING;

  let totalWeight   = 0;
  let weightedScore = 0;
  const detail = {};
  const contributing = [];

  for (const vote of votes) {
    const name   = String(vote.name ?? '');
    const v      = Number(vote.vote ?? 0);
    const conf   = Math.min(1, Math.max(0, Number(vote.confidence ?? 1)));
    const w      = (baseWeights[name] ?? 0.05);
    const effectiveW = w * conf;

    weightedScore += v * effectiveW;
    totalWeight   += effectiveW;
    detail[name]   = { vote: v, weight: w, confidence: conf };

    if (Math.abs(v) > 0) contributing.push(name);
  }

  if (totalWeight === 0) return { finalVote: 0, score: 0, confidence: 0, contributingIndicators: [], detail };

  const score     = weightedScore / totalWeight;
  const threshold = numEnv('LUNA_TA_WEIGHTED_VOTING_THRESHOLD', 0.20);
  const finalVote = score > threshold ? 1 : score < -threshold ? -1 : 0;
  const confidence = Math.min(1, Math.abs(score) * 2);

  return { finalVote, score, confidence, contributingIndicators: contributing, detail, regime: regimeKey };
}

// ─── OHLCV + 지표 → 투표 변환 헬퍼 ─────────────────────────────────

export function buildVotesFromIndicators({ rsi, macd, bb, mas, stoch, vol, atr, divergence, crossSignals, patterns, supportResistance, currentPrice } = {}) {
  const votes = [];

  // RSI
  if (rsi != null) {
    const rsiVote = rsi < 30 ? 1 : rsi > 70 ? -1 : rsi < 45 ? 0.5 : rsi > 55 ? -0.5 : 0;
    votes.push({ name: 'rsi', vote: Math.sign(rsiVote) || 0, confidence: Math.min(1, Math.abs(rsiVote)) });
  }

  // MACD
  if (macd?.histogram != null) {
    const v = macd.histogram > 0 ? 1 : -1;
    const conf = Math.min(1, Math.abs(macd.histogram) * 10);
    votes.push({ name: 'macd', vote: v, confidence: conf });
  }

  // Bollinger
  if (bb && currentPrice) {
    const bbRange = bb.upper - bb.lower;
    if (bbRange > 0) {
      const bbPct = (currentPrice - bb.lower) / bbRange;
      const v = bbPct <= 0.1 ? 1 : bbPct >= 0.9 ? -1 : 0;
      votes.push({ name: 'bollinger', vote: v, confidence: Math.abs(bbPct - 0.5) * 2 });
    }
  }

  // Stochastic
  if (stoch?.k != null) {
    const v = stoch.k < 20 ? 1 : stoch.k > 80 ? -1 : 0;
    votes.push({ name: 'stochastic', vote: v, confidence: v !== 0 ? 0.7 : 0.3 });
  }

  // MA 정배열 (golden/death cross 포함)
  if (crossSignals?.length) {
    const goldCount = crossSignals.filter(s => s.type === 'golden_cross').length;
    const deathCount = crossSignals.filter(s => s.type === 'death_cross').length;
    if (goldCount > 0)  votes.push({ name: 'golden_cross', vote: 1, confidence: goldCount / 3 });
    if (deathCount > 0) votes.push({ name: 'death_cross',  vote: -1, confidence: deathCount / 3 });
  }

  // 다이버전스
  if (divergence?.overall) {
    const divVote = divergence.overall === 'bullish' ? 1 : divergence.overall === 'bearish' ? -1 : 0;
    if (divVote !== 0) {
      const divConf = divVote === 1 ? divergence.bullishScore : divergence.bearishScore;
      votes.push({ name: 'divergence', vote: divVote, confidence: divConf });
    }
  }

  // 차트 패턴
  if (patterns) {
    if (patterns.bullishScore > 0) votes.push({ name: 'pattern', vote: 1, confidence: patterns.bullishScore });
    if (patterns.bearishScore > 0) votes.push({ name: 'pattern', vote: -1, confidence: patterns.bearishScore });
  }

  // 거래량
  if (vol?.surge != null) {
    const v = vol.ratio > 1.5 ? (vol.ratio > 2.0 ? 1 : 0) : 0;
    if (v !== 0) votes.push({ name: 'volume', vote: v, confidence: Math.min(1, (vol.ratio - 1.5) / 2) });
  }

  // 지지/저항
  if (supportResistance) {
    if (supportResistance.atSupport)    votes.push({ name: 'support_resistance', vote: 1,  confidence: 0.7 });
    if (supportResistance.atResistance) votes.push({ name: 'support_resistance', vote: -1, confidence: 0.7 });
  }

  return votes;
}

export default { aggregateVotes, buildVotesFromIndicators, REGIME_WEIGHTS };
