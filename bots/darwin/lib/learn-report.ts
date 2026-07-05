'use strict';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const env: { PROJECT_ROOT: string } = require('../../../packages/core/lib/env');
const proposalStore = require('./proposal-store.ts');

const DEFAULT_LEARNINGS_PATH = path.join(env.PROJECT_ROOT, 'bots/darwin/docs/learnings.md');

interface LearnReportOptions {
  sinceDays?: number;
  now?: Date | string | number;
  learningsPath?: string;
  proposals?: Array<Record<string, unknown>>;
  keywordEvolutionCount?: number;
}

interface ParsedLearningLine {
  raw: string;
  date: string;
  reason: string;
  proposal: string;
}

function parseLearningLine(raw: string): ParsedLearningLine | null {
  const line = String(raw || '').trim();
  if (!line) return null;
  const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!dateMatch) return null;
  const reasonMatch = line.match(/\breason=([^|]+)/);
  const proposalMatch = line.match(/\bproposal=([^|]+)/);
  return {
    raw: line,
    date: dateMatch[1],
    reason: String(reasonMatch?.[1] || 'unknown').trim(),
    proposal: String(proposalMatch?.[1] || '').trim(),
  };
}

function readLearningLines(filePath = DEFAULT_LEARNINGS_PATH): ParsedLearningLine[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(parseLearningLine)
    .filter((line): line is ParsedLearningLine => line !== null);
}

function sinceCutoff(options: LearnReportOptions): number {
  const nowMs = options.now == null ? Date.now() : new Date(options.now).getTime();
  const sinceDays = Number.isFinite(options.sinceDays) ? Number(options.sinceDays) : 7;
  return nowMs - Math.max(1, sinceDays) * 86_400_000;
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item) || 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function safeNormalizeState(status: unknown): string {
  try {
    return String(proposalStore.normalizeProposalState(status));
  } catch {
    return String(status || 'proposed');
  }
}

function predicateResultsOf(proposal: Record<string, unknown>): Array<Record<string, unknown>> {
  const measurement = proposal.measurement && typeof proposal.measurement === 'object'
    ? proposal.measurement as Record<string, unknown>
    : {};
  const results = Array.isArray(measurement.predicate_results) ? measurement.predicate_results : [];
  return results.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item));
}

function summarizeProposals(proposals: Array<Record<string, unknown>>) {
  const states = countBy(proposals, (proposal) => safeNormalizeState(proposal.status));
  const measured = proposals.filter((proposal) => safeNormalizeState(proposal.status) === 'measured');
  const adopted = proposals.filter((proposal) => safeNormalizeState(proposal.status) === 'adopted');
  const archived = proposals.filter((proposal) => safeNormalizeState(proposal.status) === 'archived');
  const predicateResults = proposals.flatMap(predicateResultsOf);
  const predicatePassed = predicateResults.filter((item) => item.ok === true).length;
  const predicateFailed = predicateResults.filter((item) => item.ok !== true).length;
  const predicateTotal = predicatePassed + predicateFailed;
  return {
    total: proposals.length,
    states,
    measured: measured.length,
    adopted: adopted.length,
    archived: archived.length,
    predicateMeasured: measured.filter((proposal) => predicateResultsOf(proposal).length > 0).length,
    predicateAssertions: predicateTotal,
    predicatePassed,
    predicateFailed,
    predicatePassRate: predicateTotal > 0 ? Number(((predicatePassed / predicateTotal) * 100).toFixed(1)) : null,
  };
}

function collectLearnReport(options: LearnReportOptions = {}) {
  const cutoff = sinceCutoff(options);
  const lines = readLearningLines(options.learningsPath)
    .filter((line) => {
      const lineTime = Date.parse(line.date);
      return Number.isFinite(lineTime) && lineTime >= cutoff;
    });
  const proposals = options.proposals || proposalStore.listProposals();
  const reasons = countBy(lines, (line) => line.reason).slice(0, 5);
  return {
    sinceDays: Number.isFinite(options.sinceDays) ? Number(options.sinceDays) : 7,
    newLearningLines: lines.length,
    topReasons: reasons,
    recentLearnings: lines.slice(-5),
    proposalStats: summarizeProposals(proposals),
    keywordEvolutionCount: Number(options.keywordEvolutionCount || 0),
  };
}

function formatLearnReportBlock(report: ReturnType<typeof collectLearnReport>): string {
  const proposal = report.proposalStats;
  const passRate = proposal.predicatePassRate == null ? 'N/A' : `${proposal.predicatePassRate}%`;
  const reasons = report.topReasons.length > 0
    ? report.topReasons.map((item) => `${item.key}:${item.count}`).join(', ')
    : 'N/A';
  return [
    '🧠 LEARN:',
    `  신규 learning: ${report.newLearningLines}줄 | 주요 reason: ${reasons}`,
    `  measured/adopted/archived: ${proposal.measured}/${proposal.adopted}/${proposal.archived}`,
    `  predicate: ${proposal.predicatePassed}/${proposal.predicateAssertions} pass (${passRate})`,
    `  keyword evolution: ${report.keywordEvolutionCount}`,
  ].join('\n');
}

module.exports = {
  DEFAULT_LEARNINGS_PATH,
  parseLearningLine,
  readLearningLines,
  collectLearnReport,
  formatLearnReportBlock,
  _testOnly_summarizeProposals: summarizeProposals,
};
