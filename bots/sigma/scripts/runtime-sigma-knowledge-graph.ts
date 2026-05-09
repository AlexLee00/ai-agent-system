import {
  buildKnowledgeGraphPersistPlan,
  buildKnowledgeGraphSnapshot,
  persistKnowledgeGraphPlan,
} from '../ts/lib/knowledge-graph.js';
import { collectLibraryRecords } from '../ts/lib/library-data-source.js';

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const apply = hasArg('--apply');
const confirm = argValue('--confirm');
const dryRun = !(apply && confirm === 'sigma-knowledge-graph-apply');
const sourceReport = await collectLibraryRecords({
  sinceHours: Number(argValue('--since-hours') ?? 24 * 7),
  limitPerSource: Number(argValue('--limit-per-source') ?? 80),
});
const texts = sourceReport.records.map((record) => record.piiRedactedText).filter(Boolean);
const snapshot = buildKnowledgeGraphSnapshot(texts);
const plan = buildKnowledgeGraphPersistPlan(snapshot, { dryRun });
const persisted = await persistKnowledgeGraphPlan(plan, { confirm });

console.log(JSON.stringify({
  ok: persisted.ok,
  status: persisted.dryRun ? 'knowledge_graph_dry_run_ready' : 'knowledge_graph_apply_complete',
  source: sourceReport.stats,
  sourceWarnings: sourceReport.warnings,
  snapshot: {
    nodes: snapshot.nodes.length,
    edges: snapshot.edges.length,
    communities: snapshot.communities.length,
  },
  plan: {
    dryRun: plan.dryRun,
    rows: plan.rows.length,
  },
  persisted,
  applyBlocked: apply && dryRun ? 'confirm_required:sigma-knowledge-graph-apply' : null,
}, null, 2));
