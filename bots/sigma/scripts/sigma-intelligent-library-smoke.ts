import assert from 'node:assert/strict';
import {
  SIGMA_TEAMS,
  buildDatasetCards,
  buildKnowledgeGraphFromTexts,
  buildLibraryGates,
  buildLineageRecord,
  buildMemoryLayerPlan,
  createDashboardSummary,
  evaluateConstitution,
  evaluateSensitiveExport,
  getBacklinks,
  getNeighbors,
  planSelfImprovement,
  redactPii,
} from '../ts/lib/intelligent-library.js';

const gates = buildLibraryGates({});
assert.equal(gates.find((gate) => gate.phase === 'A')?.enabled, false);
assert.equal(gates.find((gate) => gate.phase === 'F2')?.enabled, true);
assert.equal(gates.find((gate) => gate.phase === 'F3')?.enabled, true);
assert.equal(gates.find((gate) => gate.phase === 'G1')?.enabled, true);

const memoryPlan = buildMemoryLayerPlan();
assert.equal(memoryPlan.length, SIGMA_TEAMS.length);
assert.ok(memoryPlan.every((entry) => entry.shortTerm && entry.episodic && entry.semantic && entry.procedural));

const graph = buildKnowledgeGraphFromTexts([
  'Luna trade failure generated reflexion for ORCA/USDT reconcile',
  'Blog naver post failure generated alarm and auto_dev incident',
]);
assert.ok(graph.nodes.length >= 6);
assert.ok(graph.edges.length >= 4);
assert.ok(getNeighbors('failure', graph.edges, 2).length > 0);
assert.ok(Array.isArray(getBacklinks('generated', graph.edges)));

const datasets = buildDatasetCards();
assert.equal(datasets.length, SIGMA_TEAMS.length * 2);
assert.ok(datasets.every((card) => card.lineageRequired && card.externalExportBlocked));

const redacted = redactPii('user alex@example.com token sk-test_1234567890abcdef phone 010-1234-5678');
assert.ok(redacted.text.includes('[REDACTED_EMAIL]'));
assert.ok(redacted.text.includes('[REDACTED_PHONE]'));
assert.ok(redacted.text.includes('[REDACTED_TOKEN]'));

const legalExport = evaluateSensitiveExport({ collection: 'rag_legal', externalExport: true, masterApproved: true });
assert.equal(legalExport.allowed, false);
const normalExport = evaluateSensitiveExport({ collection: 'rag_trades', externalExport: true, masterApproved: true });
assert.equal(normalExport.allowed, true);

const lineage = buildLineageRecord({
  dataId: 'row-1',
  sourceEventId: 42,
  sourceTeam: 'luna',
  sourceAgent: 'luna',
  payload: { symbol: 'BTC/USDT', action: 'BUY' },
});
assert.equal(lineage.contentHash.length, 64);
assert.equal(lineage.sourceEventId, 42);

const signals = [
  ...Array.from({ length: 5 }, () => ({
    team: 'luna',
    agent: 'luna',
    outcome: 'success' as const,
    pattern: 'capital aware entry',
    promptName: 'luna_entry_v2',
  })),
  ...Array.from({ length: 3 }, () => ({
    team: 'blog',
    agent: 'blo',
    outcome: 'failure' as const,
    pattern: 'missing queue claim',
  })),
];
const improvement = planSelfImprovement(signals);
assert.deepEqual(improvement.promptCandidates, ['luna_entry_v2']);
assert.equal(improvement.skillCandidates.length, 2);
assert.equal(improvement.fineTuneCandidate, false);

const constitution = evaluateConstitution({
  collection: 'rag_legal',
  text: 'case owner alex@example.com',
  externalExport: true,
  masterApproved: false,
});
assert.equal(constitution.allowed, false);
assert.ok(constitution.redactedText.includes('[REDACTED_EMAIL]'));
assert.ok(constitution.critiques.includes('rag_legal_absolute_isolation'));

const dashboard = createDashboardSummary({ texts: ['sigma library graph memory'], signals });
assert.equal(dashboard.ok, true);
assert.equal(dashboard.teams, 9);
assert.equal(dashboard.datasets, 18);
assert.ok(dashboard.selfImprovement.skillCandidates >= 2);

console.log(JSON.stringify({
  ok: true,
  status: 'sigma_intelligent_library_smoke_passed',
  teams: SIGMA_TEAMS.length,
  datasets: datasets.length,
  graphNodes: graph.nodes.length,
  graphEdges: graph.edges.length,
  skillCandidates: improvement.skillCandidates.length,
}, null, 2));
