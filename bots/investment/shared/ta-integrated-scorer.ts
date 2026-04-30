// @ts-nocheck
import { aggregateVotes, buildVotesFromIndicators } from './ta-weighted-voting.ts';
import { evaluateBullishEntry, evaluateBearishExit } from './ta-bullish-entry-conditions.ts';
import { predictionToVote } from './ml-price-predictor.ts';

export function scoreTechnicalSetup(input = {}) {
  const votes = buildVotesFromIndicators(input);
  if (input.prediction) votes.push(predictionToVote(input.prediction));
  const voteSummary = aggregateVotes(votes, input.regime || 'RANGING');
  const bullish = evaluateBullishEntry(input);
  const bearish = evaluateBearishExit(input);
  const score = Math.max(0, Math.min(1, ((voteSummary.score || 0) + 1) / 2 * 0.6 + (bullish.score || 0) * 0.4));
  const decision = bearish.exit && bearish.score > bullish.score
    ? 'exit_watch'
    : bullish.entry && voteSummary.finalVote >= 0
      ? 'entry_watch'
      : 'neutral';
  return {
    ok: true,
    score,
    decision,
    reasonCodes: [
      `vote:${voteSummary.finalVote}`,
      `bullish:${bullish.entry ? 'yes' : 'no'}`,
      `bearish_exit:${bearish.exit ? 'yes' : 'no'}`,
    ],
    evidence: {
      voteSummary,
      bullish,
      bearish,
      contributingIndicators: voteSummary.contributingIndicators || [],
    },
  };
}

export default { scoreTechnicalSetup };
