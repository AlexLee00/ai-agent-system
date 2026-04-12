// @ts-nocheck
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildScreeningHistoryReport } from './screening-history-report.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INVESTMENT_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(INVESTMENT_ROOT, '..', '..');
const ELIXIR_ROOT = path.resolve(REPO_ROOT, 'elixir', 'team_jay');

const INVESTMENT_LABEL_PATTERN = /ai\.investment\.[^\s"]+/g;
const PORT_AGENT_NAMES = [
  'luna_commander',
  'luna_crypto',
  'luna_crypto_validation',
  'luna_domestic',
  'luna_domestic_validation',
  'luna_overseas',
  'luna_overseas_validation',
  'argos',
  'invest_health_check',
  'unrealized_pnl',
  'prescreen_domestic',
  'prescreen_overseas',
  'market_alert_domestic_open',
  'market_alert_domestic_close',
  'market_alert_overseas_open',
  'market_alert_overseas_close',
  'market_alert_crypto_daily',
  'reporter',
  'daily_feedback',
];

function runCommand(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd || INVESTMENT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(options.env || {}),
    },
  });
}

function tryRunCommand(command, args, options = {}) {
  try {
    return { ok: true, output: runCommand(command, args, options) };
  } catch (error) {
    return {
      ok: false,
      error: error?.stderr || error?.stdout || error?.message || String(error),
    };
  }
}

function extractJsonMarker(output) {
  const line = String(output || '')
    .split('\n')
    .find((item) => item.startsWith('__JSON__'));
  if (!line) throw new Error('JSON marker not found');
  return JSON.parse(line.slice('__JSON__'.length));
}

function loadHealthReport() {
  const result = tryRunCommand('node', [
    path.resolve(INVESTMENT_ROOT, 'scripts', 'health-report.ts'),
    '--json',
  ]);
  if (!result.ok) {
    return {
      serviceHealth: { okCount: null, warnCount: null, ok: [], warn: [] },
      decision: null,
      cryptoLiveGateHealth: null,
      error: String(result.error || 'health-report failed').trim(),
    };
  }
  return { ...JSON.parse(result.output), error: null };
}

async function loadScreeningHistory() {
  try {
    const [crypto, domestic, overseas] = await Promise.all([
      buildScreeningHistoryReport({ market: 'crypto', limit: 3, json: true }),
      buildScreeningHistoryReport({ market: 'domestic', limit: 3, json: true }),
      buildScreeningHistoryReport({ market: 'overseas', limit: 3, json: true }),
    ]);
    return { crypto, domestic, overseas, error: null };
  } catch (error) {
    return {
      crypto: null,
      domestic: null,
      overseas: null,
      error: String(error?.message || error).trim(),
    };
  }
}

function loadLaunchdLabels() {
  const result = tryRunCommand('launchctl', ['list'], { cwd: REPO_ROOT });
  if (!result.ok) {
    return {
      labels: [],
      error: String(result.error || 'launchctl list failed').trim() || 'launchctl list failed',
    };
  }
  const labels = new Set(String(result.output || '').match(INVESTMENT_LABEL_PATTERN) || []);
  return { labels: Array.from(labels).sort(), error: null };
}

function loadOverlapReport() {
  const result = tryRunCommand(
    'mix',
    [
      'run',
      '-e',
      `report = TeamJay.Diagnostics.shadow_report(); map = %{overlap_count: report.overlap_count, investment_overlaps: Enum.filter(report.overlaps, &(String.starts_with?(&1, "ai.investment."))), recommended_actions: report.recommended_actions}; IO.puts("__JSON__" <> Jason.encode!(map))`,
    ],
    { cwd: ELIXIR_ROOT },
  );
  if (!result.ok) {
    return {
      overlap_count: null,
      investment_overlaps: [],
      recommended_actions: [],
      error: String(result.error || 'mix shadow_report failed').trim(),
    };
  }
  return { ...extractJsonMarker(result.output), error: null };
}

function loadPortAgentStatuses() {
  const result = tryRunCommand(
    'mix',
    [
      'run',
      '-e',
      `names = ${JSON.stringify(PORT_AGENT_NAMES)} |> Enum.map(&String.to_atom/1); rows = Enum.map(names, fn name -> status = TeamJay.Agents.PortAgent.get_status(name); %{name: Atom.to_string(name), status: status.status, runs: status.runs, consecutive_failures: status.consecutive_failures} end); IO.puts("__JSON__" <> Jason.encode!(rows))`,
    ],
    { cwd: ELIXIR_ROOT },
  );
  if (!result.ok) {
    return {
      rows: [],
      error: String(result.error || 'mix port agent status failed').trim(),
    };
  }
  return { rows: extractJsonMarker(result.output), error: null };
}

async function buildSnapshot() {
  const launchd = loadLaunchdLabels();
  const overlap = loadOverlapReport();
  const portAgents = loadPortAgentStatuses();
  const health = loadHealthReport();
  const screening = await loadScreeningHistory();

  return {
    capturedAt: new Date().toISOString(),
    launchd: {
      investmentLabels: launchd.labels,
      count: launchd.labels.length,
      error: launchd.error,
    },
    overlap,
    portAgents: portAgents.rows,
    portAgentError: portAgents.error,
    health: {
      serviceHealth: health.serviceHealth,
      decision: health.decision,
      cryptoLiveGateHealth: health.cryptoLiveGateHealth,
      error: health.error,
    },
    screening,
  };
}

function printText(snapshot) {
  console.log(`\n📸 병렬 운영 스냅샷 — ${snapshot.capturedAt}`);
  console.log('');
  console.log(`launchd 투자팀: ${snapshot.launchd.count}개`);
  if (snapshot.launchd.error) {
    console.log(`  ⚠️ launchd 조회 실패: ${snapshot.launchd.error}`);
  }
  snapshot.launchd.investmentLabels.forEach((label) => console.log(`  - ${label}`));
  console.log('');
  console.log(`diagnostics overlap: ${snapshot.overlap.investment_overlaps.length}개`);
  if (snapshot.overlap.error) {
    console.log(`  ⚠️ diagnostics 조회 실패: ${snapshot.overlap.error}`);
  }
  snapshot.overlap.investment_overlaps.forEach((label) => console.log(`  - ${label}`));
  console.log('');
  console.log(`serviceHealth: ok ${snapshot.health.serviceHealth.okCount} / warn ${snapshot.health.serviceHealth.warnCount}`);
  if (snapshot.health.error) {
    console.log(`  ⚠️ health-report 조회 실패: ${snapshot.health.error}`);
  }
  snapshot.health.serviceHealth.ok.forEach((line) => console.log(line));
  snapshot.health.serviceHealth.warn.forEach((line) => console.log(line));
  console.log('');
  console.log('PortAgent 상태:');
  if (snapshot.portAgentError) {
    console.log(`  ⚠️ PortAgent 조회 실패: ${snapshot.portAgentError}`);
  }
  snapshot.portAgents.forEach((row) => {
    console.log(`  - ${row.name}: ${row.status} / runs=${row.runs} / failures=${row.consecutive_failures}`);
  });
  console.log('');
  if (snapshot.screening?.error) {
    console.log(`screening_history: ⚠️ ${snapshot.screening.error}`);
    console.log('');
  } else if (snapshot.screening) {
    console.log('screening_history 요약:');
    for (const market of ['crypto', 'domestic', 'overseas']) {
      const summary = snapshot.screening[market]?.summary;
      if (!summary) continue;
      console.log(`  - ${market}: rows=${summary.totalRows}, unique=${summary.uniqueDynamicSymbols}`);
      const top = (summary.topSymbols || []).slice(0, 3).map((item) => `${item.symbol}(${item.count})`).join(', ');
      if (top) console.log(`    top: ${top}`);
    }
    console.log('');
  }
  if (snapshot.health.cryptoLiveGateHealth?.warn?.length) {
    console.log('crypto LIVE gate:');
    snapshot.health.cryptoLiveGateHealth.warn.forEach((line) => console.log(line));
  }
}

async function main() {
  const json = process.argv.includes('--json');
  const snapshot = await buildSnapshot();
  if (json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  printText(snapshot);
}

await main();
