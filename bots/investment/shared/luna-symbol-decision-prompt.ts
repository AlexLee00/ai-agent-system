// @ts-nocheck

export function buildAnalysisSummary(analyses, ANALYST_TYPES) {
  if (!analyses || analyses.length === 0) return '분석 데이터 없음';
  return analyses.map(a => {
    const label = a.analyst === ANALYST_TYPES.TA_MTF    ? 'TA(MTF)'
                : a.analyst === ANALYST_TYPES.ONCHAIN   ? '온체인'
                : a.analyst === ANALYST_TYPES.SENTINEL  ? 'sentinel'
                : a.analyst === ANALYST_TYPES.NEWS      ? '뉴스'
                : a.analyst === ANALYST_TYPES.SENTIMENT ? '감성'
                : a.analyst === ANALYST_TYPES.X_SEARCH  ? 'X감성'
                : 'TA';
    return `[${label}] ${a.signal} | ${((a.confidence || 0) * 100).toFixed(0)}% | ${a.reasoning || ''}`;
  }).join('\n');
}

function getExchangeLabel(exchange) {
  return exchange === 'kis_overseas' ? '미국주식' : exchange === 'kis' ? '국내주식' : '암호화폐';
}

function buildFusedSection(fused) {
  return `\n\n[시그널 융합] 방향=${fused.recommendation} | 점수=${fused.fusedScore.toFixed(3)} | 평균확신도=${(fused.averageConfidence * 100).toFixed(0)}%${fused.hasConflict ? ' | ⚠️ 신호 충돌' : ''}`;
}

function buildReviewSection(reviewHint) {
  return reviewHint.notes.length > 0
    ? `\n[리뷰 힌트] ${reviewHint.notes.join(' / ')}`
    : '';
}

function buildDebateSection(debate) {
  if (!debate) return '';
  const bullText = debate.bull
    ? `목표가 ${debate.bull.targetPrice} | 상승 ${debate.bull.upsidePct}% | ${debate.bull.reasoning}`
    : '데이터 없음';
  const bearText = debate.bear
    ? `목표가 ${debate.bear.targetPrice} | 하락 ${debate.bear.downsidePct}% | ${debate.bear.reasoning}`
    : '데이터 없음';
  return `\n\n[강세 리서처] ${bullText}\n[약세 리서처] ${bearText}`;
}

export function createLunaSymbolDecisionPromptBuilder({
  ANALYST_TYPES,
  RAG_RUNTIME,
  fuseSignals,
  loadReviewConfidenceHint,
  recommendStrategy,
  searchRag,
  getMarketRegime,
  formatMarketRegime,
  buildStrategyRoute,
  buildStrategyRouteSection,
}) {
  async function buildStrategySection(strategy) {
    try {
      if (!strategy) return '';
      return `\n\n[참고 전략 — 아르고스]\n${strategy.strategy_name}: ${strategy.entry_condition || '진입 조건 없음'} (품질점수 ${strategy.quality_score?.toFixed(2)})`;
    } catch {
      return '';
    }
  }

  async function buildRagContext(symbol, summary) {
    try {
      const hits = await searchRag(
        'trades',
        `${symbol} ${summary.slice(0, 100)}`,
        {
          limit: Number(RAG_RUNTIME.lunaTradeContext?.limit ?? 3),
          threshold: Number(RAG_RUNTIME.lunaTradeContext?.threshold ?? 0.7),
        },
        { sourceBot: 'luna' },
      );
      if (hits.length === 0) return '';
      return '\n\n[과거 유사 신호]\n' + hits.map(h => {
        const m = h.metadata || {};
        return `  ${m.symbol || '?'} ${m.action || '?'} (신뢰도 ${m.confidence || '?'}): ${h.content.slice(0, 80)}`;
      }).join('\n');
    } catch {
      return '';
    }
  }

  async function buildSymbolDecisionPromptParts({ symbol, analyses, exchange, debate, analystWeights }) {
    const summary = buildAnalysisSummary(analyses, ANALYST_TYPES);
    const label = getExchangeLabel(exchange);
    const fused = fuseSignals(analyses, analystWeights);
    const reviewHint = await loadReviewConfidenceHint(symbol, exchange);
    const [argosStrategy, ragContext, marketRegime] = await Promise.all([
      recommendStrategy(symbol, exchange).catch(() => null),
      buildRagContext(symbol, summary),
      getMarketRegime(exchange).catch(() => null),
    ]);
    const strategyRoute = await buildStrategyRoute({
      symbol,
      exchange,
      analyses,
      fused,
      marketRegime,
      argosStrategy,
    });
    const strategySection = await buildStrategySection(argosStrategy);
    const regimeSection = marketRegime ? `\n\n${formatMarketRegime(marketRegime)}` : '';
    const userMsg = `심볼: ${symbol} (${label})\n\n분석 결과:\n${summary}${buildFusedSection(fused)}${buildReviewSection(reviewHint)}${buildDebateSection(debate)}${strategySection}${buildStrategyRouteSection(strategyRoute)}${ragContext}${regimeSection}\n\n최종 매매 신호:`;

    return {
      summary,
      label,
      fused,
      reviewHint,
      strategyRoute,
      userMsg,
    };
  }

  return { buildSymbolDecisionPromptParts };
}
