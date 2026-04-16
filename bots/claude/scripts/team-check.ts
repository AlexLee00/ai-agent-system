// @ts-nocheck
'use strict';

/**
 * scripts/team-check.js — 팀별 덱스터 체크
 *
 * 사용법:
 *   node scripts/team-check.js [--team=claude|ska|luna|all] [--telegram]
 *
 * 출력:
 *   stdout → JSON { success, message }  (OpenClaw/스카 호환)
 *   stderr → 사람 읽기용 콘솔
 *
 * npm scripts (bots/claude):
 *   npm run check:claude | check:ska | check:luna | check:all
 */

const { publishToMainBot } = require('../lib/mainbot-client');
const kst = require('../../../packages/core/lib/kst');

// ── 아이콘 ───────────────────────────────────────────────────────────
const ICON = { ok: '✅', warn: '⚠️', error: '❌' };

// ── Check 모듈 (지연 require — 팀별 필요한 것만) ──────────────────────
const RUNNERS = {
  code:      () => require('../lib/checks/code').run(),
  database:  () => require('../lib/checks/database').run(),
  security:  () => require('../lib/checks/security').run(),
  logs:      () => require('../lib/checks/logs').run(),
  bots:      () => require('../lib/checks/bots').run(),
  resources: () => require('../lib/checks/resources').run(),
  network:   () => require('../lib/checks/network').run(),
  ska:       () => require('../lib/checks/ska').run(),
  deps:      () => require('../lib/checks/deps').run(false), // npm audit 생략 (빠른 체크)
};

// ── 팀 설정 ─────────────────────────────────────────────────────────
// botFilter: bots 체크 결과에서 해당 키워드가 포함된 항목만 표시
const TEAMS = {
  claude: {
    name:      '클로드팀',
    checks:    ['bots', 'code', 'database', 'security', 'logs', 'deps'],
    botFilter: ['클로드팀'],
  },
  ska: {
    name:      '스카팀',
    checks:    ['ska', 'bots'],
    botFilter: ['스카팀', 'OpenClaw'],
  },
  luna: {
    name:      '루나팀',
    checks:    ['bots', 'resources', 'network'],
    botFilter: ['루나팀'],
  },
  all: {
    name:      '전체',
    checks:    ['resources', 'network', 'bots', 'ska', 'logs', 'security', 'database', 'code', 'deps'],
    botFilter: null,
  },
};

// ── bots 체크 결과 필터링 ────────────────────────────────────────────
function filterBots(result, keywords) {
  if (!keywords) return result;

  const items = result.items.filter(item =>
    keywords.some(kw => item.label.includes(kw))
  );

  if (items.length === 0) return null; // 해당 팀 항목 없으면 섹션 생략

  const hasError = items.some(i => i.status === 'error');
  const hasWarn  = items.some(i => i.status === 'warn');
  return {
    ...result,
    status: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    items,
  };
}

// ── 메시지 포맷 (텔레그램 + 콘솔 겸용 plain text) ──────────────────────
function buildMessage(teamName, results, elapsed) {
  const overall = results.some(r => r.status === 'error') ? 'error'
                : results.some(r => r.status === 'warn')  ? 'warn'
                : 'ok';

  const ts = kst.toKST(new Date());

  const lines = [
    `🤖 덱스터 ${teamName} 점검 ${ICON[overall]}`,
    `📅 ${ts}`,
    '',
  ];

  for (const r of results) {
    if (r.status === 'ok') {
      lines.push(`${ICON.ok} ${r.name}`);
    } else {
      lines.push(`${ICON[r.status]} ${r.name}`);
      for (const item of r.items.filter(i => i.status !== 'ok')) {
        lines.push(`  ${ICON[item.status]} ${item.label}: ${item.detail}`);
      }
      lines.push('');
    }
  }

  lines.push('');

  const errors = results.flatMap(r => r.items.filter(i => i.status === 'error'));
  const warns  = results.flatMap(r => r.items.filter(i => i.status === 'warn'));

  if (overall === 'ok') {
    lines.push('이상 없음 ✨');
  } else {
    lines.push(`❌ ${errors.length}건  ⚠️ ${warns.length}건`);
  }

  lines.push(`소요: ${elapsed}ms`);
  return lines.join('\n');
}

// ── 메인 ─────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const teamKey    = (argv.find(a => a.startsWith('--team=')) || '--team=all').replace('--team=', '');
  const doTelegram = argv.includes('--telegram');

  const cfg = TEAMS[teamKey];
  if (!cfg) {
    const msg = `알 수 없는 팀: ${teamKey} — claude|ska|luna|all 중 선택`;
    console.log(JSON.stringify({ success: false, message: msg }));
    process.exit(1);
  }

  process.stderr.write(`\n🤖 덱스터 ${cfg.name} 점검 시작...\n`);
  const t0 = Date.now();
  const results = [];

  for (const name of cfg.checks) {
    process.stderr.write(`  ▶ ${name} 체크 중...\n`);
    const raw = await RUNNERS[name]();

    if (name === 'bots' && cfg.botFilter) {
      const filtered = filterBots(raw, cfg.botFilter);
      if (filtered) results.push(filtered);
    } else {
      results.push(raw);
    }
  }

  const elapsed = Date.now() - t0;
  const message = buildMessage(cfg.name, results, elapsed);

  // 콘솔 출력 (stderr — JSON 파싱 방해 안 함)
  process.stderr.write('\n' + message + '\n\n');

  // 제이 큐 발행 (--telegram 플래그 시)
  if (doTelegram) publishToMainBot({ from_bot: 'dexter', event_type: 'report', alert_level: 1, message });

  // OpenClaw/스카 호환 JSON (stdout)
  console.log(JSON.stringify({ success: true, message }));
}

main().catch(e => {
  console.log(JSON.stringify({ success: false, message: `팀 체크 오류: ${e.message}` }));
  process.exit(1);
});
