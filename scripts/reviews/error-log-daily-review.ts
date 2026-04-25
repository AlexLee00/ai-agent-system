// @ts-nocheck
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

const LOG_TARGETS = [
  { team: 'orchestrator', bot: 'jay', label: '제이 runtime', path: path.join(HOME, '.openclaw', 'logs', 'orchestrator-error.log') },
  { team: 'orchestrator', bot: 'openclaw', label: 'OpenClaw gateway', path: path.join(HOME, '.openclaw', 'logs', 'gateway.err.log') },
  { team: 'reservation', bot: 'ska', label: '스카 commander', path: path.join(HOME, '.openclaw', 'workspace', 'logs', 'ska-commander-error.log') },
  { team: 'reservation', bot: 'naver', label: '네이버 ops', path: '/tmp/naver-ops-mode.log' },
  { team: 'reservation', bot: 'jimmy', label: '픽코 키오스크', path: '/tmp/pickko-kiosk-monitor.log' },
  { team: 'investment', bot: 'crypto', label: '루나 크립토', path: '/tmp/investment-crypto.err.log' },
  { team: 'investment', bot: 'domestic', label: '루나 국내', path: '/tmp/investment-domestic.err.log' },
  { team: 'investment', bot: 'overseas', label: '루나 해외', path: '/tmp/investment-overseas.err.log' },
  { team: 'investment', bot: 'argos', label: '루나 argos', path: '/tmp/investment-argos.err.log' },
  { team: 'claude', bot: 'commander', label: '클로드 commander', path: path.join(HOME, '.openclaw', 'workspace', 'logs', 'claude-commander-error.log') },
  { team: 'claude', bot: 'dashboard', label: '클로드 dashboard', path: path.join(HOME, '.openclaw', 'workspace', 'logs', 'claude-health-dashboard-error.log') },
];

const CATEGORY_RULES = [
  { id: 'llm_rate_limit', label: 'LLM rate limit', severity: 'high', re: /rate.?limit|too many requests|http 429/i },
  { id: 'dns_resolution', label: 'DNS/호스트 해석 실패', severity: 'high', re: /enotfound|getaddrinfo|dns/i },
  { id: 'missing_module', label: '모듈 누락', severity: 'high', re: /cannot find module|module not found/i },
  { id: 'node_missing', label: 'node 명령 누락', severity: 'high', re: /node: command not found|command not found: node/i },
  { id: 'path_error', label: '경로 오류', severity: 'medium', re: /\bcd: .*no such file or directory|enoent/i },
  { id: 'playwright_timeout', label: '브라우저 타임아웃', severity: 'medium', re: /timeouterror|timeout .*exceeded|navigation timeout/i },
  { id: 'auth_login', label: '로그인/인증 실패', severity: 'high', re: /not logged in|login failed|인증 실패|로그인/i },
  { id: 'insufficient_balance', label: '잔고 부족', severity: 'high', re: /insufficient|잔고 부족|balance.*low/i },
  { id: 'withdrawal_delay', label: '출금 지연', severity: 'medium', re: /withdrawal.*delay|출금지연/i },
  { id: 'argument_error', label: '인자 부족/형식 오류', severity: 'medium', re: /missing.*argument|필수 인자|price.*amount/i },
  { id: 'deprecation', label: 'Deprecation 경고', severity: 'low', re: /deprecationwarning|deprecated/i },
  { id: 'db_error', label: 'DB 오류', severity: 'high', re: /sql|database|postgres|duckdb|sqlite|relation .* does not exist/i },
];

const TIMESTAMP_PATTERNS = [
  /(?<iso>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/,
  /\[(?<bracket>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/,
  /(?<plain>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/,
];

const ACTIVE_WINDOW_MS = 3 * 60 * 60 * 1000;

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const linesArg = argv.find((arg) => arg.startsWith('--lines='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || 1)),
    lines: Math.max(100, Number(linesArg?.split('=')[1] || 400)),
    json: argv.includes('--json'),
  };
}

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

function severityRank(severity) {
  if (severity === 'high') return 3;
  if (severity === 'medium') return 2;
  return 1;
}

function readLastLines(filePath, limit) {
  if (!fs.existsSync(filePath)) return [];
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).slice(-limit);
  } catch {
    return [];
  }
}

function parseLineTimestamp(line) {
  for (const pattern of TIMESTAMP_PATTERNS) {
    const match = line.match(pattern);
    if (!match || !match.groups) continue;
    const raw = match.groups.iso || match.groups.bracket || match.groups.plain;
    if (!raw) continue;
    const ts = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const value = Date.parse(ts);
    if (!Number.isNaN(value)) return value;
  }
  return null;
}

function normalizeLine(line) {
  return line
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function detectCategory(line) {
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(line)) return rule;
  }
  return { id: 'generic_error', label: '일반 오류', severity: 'medium', re: null };
}

function isInteresting(line) {
  return /❌|⚠️|error|warn|fatal|exception|rejection|timeout|failed|insufficient|enotfound|deprecated/i.test(line);
}

function shouldIgnoreIncident(target, line) {
  const text = String(line || '');

  if (target.team === 'investment') {
    if (/USDT 잔고 부족/i.test(text)) return true;
    if (/concurrency_guard_active|collect_overload_detected/i.test(text)) return true;
    if (/데이터 부족 \(\d+캔들\)/i.test(text)) return true;
    if (/접근 거부\(403\)/i.test(text)) return true;
    if (/출금지연제/i.test(text)) return true;
  }

  if (target.team === 'claude') {
    if (/DEP0187/i.test(text) && /fs\.existsSync|existsSync/i.test(text)) return true;
    if (/Passing invalid argument types to fs\.existsSync is deprecated/i.test(text)) return true;
    if (/node: command not found|command not found: node/i.test(text)) return true;
    if (/cd: undefined: No such file or directory/i.test(text)) return true;
    if (/DEP0169/i.test(text) && /url\.parse/i.test(text)) return true;
    if (/sysctl: command not found/i.test(text)) return true;
    if (/DEP0040/i.test(text) && /punycode/i.test(text)) return true;
    if (/node --trace-deprecation/i.test(text)) return true;
    if (/커넥션 풀 80%\+ 사용/i.test(text)) return true;
    if (/payload normalized with warnings: summary_coerced_to_string/i.test(text)) return true;
    if (/^\[클로드\] 명령 처리 오류:\s*$/i.test(text)) return true;
    if (/^\[pg-pool\] 쿼리 재시도 \d+\/\d+.*:\s*$/i.test(text)) return true;
  }

  return false;
}

function collectIncidents(target, days, maxLines) {
  const recentCutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
  const lines = readLastLines(target.path, maxLines);
  const incidents = [];

  for (const line of lines) {
    if (!isInteresting(line)) continue;
    if (shouldIgnoreIncident(target, line)) continue;
    const lineTs = parseLineTimestamp(line);
    if (lineTs && lineTs < recentCutoff) continue;
    const category = detectCategory(line);
    incidents.push({
      team: target.team,
      bot: target.bot,
      label: target.label,
      path: target.path,
      category: category.id,
      categoryLabel: category.label,
      severity: category.severity,
      line: line.trim(),
      normalized: normalizeLine(line),
      timestamp: lineTs,
    });
  }

  return incidents;
}

function aggregateIncidents(incidents) {
  const byGroup = new Map();
  const byTeam = new Map();
  const byCategory = new Map();
  const now = Date.now();

  for (const item of incidents) {
    const groupKey = `${item.label}|${item.category}|${item.normalized}`;
    if (!byGroup.has(groupKey)) {
      byGroup.set(groupKey, {
        team: item.team,
        bot: item.bot,
        label: item.label,
        path: item.path,
        category: item.category,
        categoryLabel: item.categoryLabel,
        severity: item.severity,
        count: 0,
        sample: item.line,
        latest: item.timestamp || 0,
        active: false,
      });
    }
    const group = byGroup.get(groupKey);
    group.count += 1;
    group.latest = Math.max(group.latest, item.timestamp || 0);
    group.active = Boolean(group.latest && (now - group.latest) <= ACTIVE_WINDOW_MS);

    if (!byTeam.has(item.label)) {
      byTeam.set(item.label, {
        label: item.label,
        team: item.team,
        count: 0,
        activeCount: 0,
        high: 0,
        medium: 0,
        low: 0,
      });
    }
    const team = byTeam.get(item.label);
    team.count += 1;
    team[item.severity] += 1;
    if (item.timestamp && (now - item.timestamp) <= ACTIVE_WINDOW_MS) team.activeCount += 1;

    if (!byCategory.has(item.category)) {
      byCategory.set(item.category, {
        category: item.category,
        label: item.categoryLabel,
        count: 0,
        activeCount: 0,
        severity: item.severity,
        latest: item.timestamp || 0,
      });
    }
    const category = byCategory.get(item.category);
    category.count += 1;
    category.latest = Math.max(category.latest, item.timestamp || 0);
    if (item.timestamp && (now - item.timestamp) <= ACTIVE_WINDOW_MS) category.activeCount += 1;
  }

  const repeated = Array.from(byGroup.values()).sort((a, b) => {
    const activeRank = Number(Boolean(b.active)) - Number(Boolean(a.active));
    if (activeRank !== 0) return activeRank;
    const sev = severityRank(b.severity) - severityRank(a.severity);
    if (sev !== 0) return sev;
    return b.count - a.count;
  });
  const teams = Array.from(byTeam.values()).sort((a, b) => {
    if (b.activeCount !== a.activeCount) return b.activeCount - a.activeCount;
    return b.count - a.count;
  });
  const categories = Array.from(byCategory.values()).sort((a, b) => {
    if (b.activeCount !== a.activeCount) return b.activeCount - a.activeCount;
    const sev = severityRank(b.severity) - severityRank(a.severity);
    if (sev !== 0) return sev;
    return b.count - a.count;
  });

  return {
    repeated,
    activeRepeated: repeated.filter((item) => item.active),
    teams,
    categories,
    activeCategories: categories.filter((item) => item.activeCount > 0),
  };
}

function buildRecommendations(categories, repeated) {
  const lines = [];
  const has = (id) => categories.find((item) => item.category === id);

  if (has('llm_rate_limit')) {
    lines.push('- LLM rate limit 반복이 있어 모델 우선순위와 fallback 체인을 다시 점검하는 게 좋습니다.');
  }
  if (has('dns_resolution')) {
    lines.push('- DNS/호스트 해석 실패가 있어 네트워크/DNS 설정 또는 curl 폴백 경로를 우선 확인해야 합니다.');
  }
  if (has('playwright_timeout') || has('auth_login')) {
    lines.push('- 브라우저 자동화 오류가 있어 로그인 상태, 대기시간, 슬롯 선택 로직을 함께 점검하는 게 좋습니다.');
  }
  if (has('insufficient_balance')) {
    lines.push('- 잔고 부족 오류가 있어 주문/예측보다 자본 상태 정리나 알림 레벨 분리가 먼저입니다.');
  }
  if (has('missing_module') || has('node_missing') || has('path_error')) {
    lines.push('- 환경/실행 경로 오류가 있어 launchd PATH, 작업 디렉터리, 의존성 배포 상태를 함께 봐야 합니다.');
  }
  const strongestRepeated = repeated[0];
  if (strongestRepeated && strongestRepeated.count >= 5) {
    lines.push(`- 가장 많이 반복된 오류는 \`${strongestRepeated.label} / ${strongestRepeated.categoryLabel}\` ${fmt(strongestRepeated.count)}회입니다. 이 경로를 우선 수정하는 편이 효과가 큽니다.`);
  }
  if (!lines.length) {
    lines.push('- 오늘 기준으로는 치명적 반복 오류가 두드러지지 않습니다. 신규 오류와 자동 복구 여부 위주로 보면 됩니다.');
  }
  return lines;
}

function main() {
  const { days, lines, json } = parseArgs();
  const incidents = LOG_TARGETS.flatMap((target) => collectIncidents(target, days, lines));
  const aggregated = aggregateIncidents(incidents);
  const activeIncidents = incidents.filter((item) => item.timestamp && (Date.now() - item.timestamp) <= ACTIVE_WINDOW_MS);
  const report = {
    periodDays: days,
    activeWindowHours: ACTIVE_WINDOW_MS / (60 * 60 * 1000),
    scannedLogs: LOG_TARGETS.map(({ label, path: filePath }) => ({ label, path: filePath, exists: fs.existsSync(filePath) })),
    totalIncidents: incidents.length,
    activeIncidents: activeIncidents.length,
    teams: aggregated.teams,
    categories: aggregated.categories,
    activeCategories: aggregated.activeCategories,
    repeated: aggregated.repeated.slice(0, 15),
    activeRepeated: aggregated.activeRepeated.slice(0, 15),
    recommendations: buildRecommendations(aggregated.activeCategories, aggregated.activeRepeated),
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const out = [];
  out.push(`📕 전체 봇 일일 오류 리뷰 (${days}일)`);
  out.push('');
  out.push(`총 감지 오류/경고: ${fmt(report.totalIncidents)}건`);
  out.push(`최근 ${fmt(report.activeWindowHours)}시간 활성 오류/경고: ${fmt(report.activeIncidents)}건`);

  if (report.teams.length) {
    out.push('');
    out.push('팀별 현황:');
    for (const item of report.teams.slice(0, 10)) {
      out.push(`- ${item.label}: 총 ${fmt(item.count)}건 / 최근 활성 ${fmt(item.activeCount)}건 (high ${fmt(item.high)} / medium ${fmt(item.medium)} / low ${fmt(item.low)})`);
    }
  }

  if (report.activeCategories.length) {
    out.push('');
    out.push('현재 활성 오류 유형:');
    for (const item of report.activeCategories.slice(0, 10)) {
      out.push(`- ${item.label}: 최근 활성 ${fmt(item.activeCount)}건 / 하루 누적 ${fmt(item.count)}건`);
    }
  }

  if (report.activeRepeated.length) {
    out.push('');
    out.push('현재 활성 반복 오류:');
    for (const item of report.activeRepeated.slice(0, 8)) {
      out.push(`- ${item.label} | ${item.categoryLabel}: ${fmt(item.count)}회`);
      out.push(`  샘플: ${item.sample.slice(0, 140)}`);
    }
  } else {
    out.push('');
    out.push(`현재 활성 반복 오류: 최근 ${fmt(report.activeWindowHours)}시간 기준 없음`);
  }

  out.push('');
  out.push('추천:');
  for (const line of report.recommendations) out.push(line);

  process.stdout.write(`${out.join('\n')}\n`);
}

main();
