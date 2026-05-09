import {
  buildMonthlySelfImprovementFixture,
  runSelfImprovementPipeline,
} from '../ts/lib/self-improvement-pipeline.js';
import { collectSelfImprovementSignals } from '../ts/lib/library-data-source.js';

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const apply = hasArg('--apply');
const confirm = argValue('--confirm');
const dryRun = hasArg('--dry-run') || !apply || confirm !== 'sigma-self-improvement-apply';
const fixture = hasArg('--fixture');
const source = fixture
  ? {
    signals: buildMonthlySelfImprovementFixture(),
    report: null,
  }
  : await collectSelfImprovementSignals({
    sinceHours: Number(process.argv.find((arg) => arg.startsWith('--since-hours='))?.slice('--since-hours='.length) ?? 24 * 7),
    limitPerSource: Number(process.argv.find((arg) => arg.startsWith('--limit-per-source='))?.slice('--limit-per-source='.length) ?? 80),
  });

const plan = await runSelfImprovementPipeline(source.signals, { dryRun });
const applyBlocked = apply && confirm !== 'sigma-self-improvement-apply' && !hasArg('--dry-run')
  ? 'confirm_required:sigma-self-improvement-apply'
  : plan.applyGate.applyBlocked;

console.log(JSON.stringify({
  ...plan,
  fixtureUsed: fixture,
  source: source.report?.stats ?? { total: source.signals.length, bySource: {}, byTeam: {}, redacted: 0, constitutionBlocked: 0 },
  sourceWarnings: source.report?.warnings ?? [],
  applyBlocked,
}, null, 2));
