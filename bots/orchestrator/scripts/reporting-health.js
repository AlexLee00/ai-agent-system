'use strict';

const {
  buildHealthReport,
  buildHealthDecision,
  buildHealthCountSection,
  buildHealthDecisionSection,
} = require('../../../packages/core/lib/health-core');
const { runHealthCli } = require('../../../packages/core/lib/health-runner');
const {
  getRecentPayloadWarnings,
  summarizePayloadWarnings,
} = require('../../../packages/core/lib/reporting-hub');

const SUMMARY_MODE = process.argv.includes('--summary');
const PRODUCER_MODE = process.argv.includes('--producers');

function buildPayloadHealth(summary) {
  if (!summary || summary.count === 0) {
    return {
      okCount: 1,
      warnCount: 0,
      ok: ['  payload 스키마 경고 없음'],
      warn: [],
    };
  }

  const latestWarning = Array.isArray(summary.latest?.warnings) && summary.latest.warnings.length > 0
    ? summary.latest.warnings.join(', ')
    : 'latest_unknown';
  return {
    okCount: 0,
    warnCount: summary.count,
    ok: [],
    warn: [
      `  최근 24시간 payload 경고 ${summary.count}건`,
      ...summary.topProducers,
      `  최근 경고: ${summary.latest?.team || 'general'}/${summary.latest?.from_bot || 'unknown'} - ${latestWarning}`,
    ],
  };
}

function buildProducerRows(entries = []) {
  const grouped = new Map();
  for (const entry of entries) {
    const key = `${entry.team || 'general'}/${entry.from_bot || 'unknown'}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        producer: key,
        count: 0,
        warnings: new Map(),
        latest: entry.ts || '',
      });
    }
    const row = grouped.get(key);
    row.count += 1;
    row.latest = entry.ts || row.latest;
    for (const warning of (entry.warnings || [])) {
      row.warnings.set(warning, (row.warnings.get(warning) || 0) + 1);
    }
  }

  return [...grouped.values()]
    .sort((a, b) => b.count - a.count || String(b.latest).localeCompare(String(a.latest)))
    .map((row) => ({
      producer: row.producer,
      count: row.count,
      latest: row.latest,
      warningSummary: [...row.warnings.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name, count]) => `${name} ${count}건`)
        .join(', '),
    }));
}

function buildSummaryLines(report) {
  if (report.payloadHealth.warnCount === 0) {
    return [
      '🧾 reporting 파이프라인 요약',
      '',
      '✅ 최근 24시간 payload 스키마 경고가 없습니다.',
      '',
      '상세: /reporting-health',
    ].join('\n');
  }

  const lines = [
    '🧾 reporting 파이프라인 요약',
    '',
    `최근 24시간 payload 경고 ${report.payloadHealth.warnCount}건`,
  ];
  for (const producer of report.topProducers) {
    lines.push(producer);
  }
  if (report.latestLine) {
    lines.push('');
    lines.push(report.latestLine);
  }
  lines.push('');
  lines.push('상세: /reporting-health');
  return lines.join('\n');
}

function buildProducerLines(report) {
  if (!Array.isArray(report.producerRows) || report.producerRows.length === 0) {
    return [
      '🧾 reporting producer 랭킹',
      '',
      '✅ 최근 24시간 payload 스키마 경고 producer가 없습니다.',
      '',
      '상세: /reporting-health',
    ].join('\n');
  }

  const lines = [
    '🧾 reporting producer 랭킹',
    '',
  ];

  for (const [index, row] of report.producerRows.slice(0, 5).entries()) {
    lines.push(`${index + 1}. ${row.producer} — ${row.count}건`);
    if (row.warningSummary) lines.push(`   ${row.warningSummary}`);
  }

  if (report.latestLine) {
    lines.push('');
    lines.push(report.latestLine);
  }
  lines.push('');
  lines.push('상세: /reporting-health');
  return lines.join('\n');
}

function buildActionLines(report) {
  if (report.payloadHealth.warnCount === 0) {
    return ['  - 현재는 관찰 유지. 상세 확인이 필요하면 /orchestrator-health 참고'];
  }
  return [
    '  - producer payload를 title/summary/details/action 표준 키로 정렬',
    '  - details/links 타입이 문자열이나 단일 값으로 들어가는 producer 우선 점검',
  ];
}

function formatText(report) {
  if (report.mode === 'producers') {
    return buildProducerLines(report);
  }
  if (report.mode === 'summary') {
    return buildSummaryLines(report);
  }
  return buildHealthReport({
    title: '🧾 reporting 파이프라인 헬스 리포트',
    sections: [
      buildHealthCountSection('■ payload 스키마 경고', report.payloadHealth, { okLimit: 2 }),
      {
        title: '■ 권장 조치',
        lines: buildActionLines(report),
      },
      {
        title: null,
        lines: buildHealthDecisionSection({
          title: '■ 운영 판단',
          recommended: report.decision.recommended,
          level: report.decision.level,
          reasons: report.decision.reasons,
          okText: '현재는 추가 조치보다 관찰 유지',
        }),
      },
    ],
    footer: ['상세: /orchestrator-health | 통합: /ops-health alerts'],
  });
}

async function buildReport() {
  const entries = getRecentPayloadWarnings({ withinHours: 24, limit: 50 });
  const summary = summarizePayloadWarnings(entries);
  const producerRows = buildProducerRows(entries);
  const payloadHealth = buildPayloadHealth(summary);
  const latestWarning = Array.isArray(summary.latest?.warnings) && summary.latest.warnings.length > 0
    ? summary.latest.warnings.join(', ')
    : 'latest_unknown';
  const decision = buildHealthDecision({
    warnings: [
      {
        active: payloadHealth.warnCount > 0,
        level: 'medium',
        reason: `reporting payload 스키마 경고 ${payloadHealth.warnCount}건이 있어 producer 규격 점검이 필요합니다.`,
      },
    ],
    okReason: 'reporting payload 스키마가 현재는 안정적으로 유지되고 있습니다.',
  });

  return {
    mode: PRODUCER_MODE ? 'producers' : SUMMARY_MODE ? 'summary' : 'full',
    payloadHealth,
    topProducers: summary.topProducers,
    producerRows,
    latestLine: summary.latest
      ? `최근 경고: ${summary.latest?.team || 'general'}/${summary.latest?.from_bot || 'unknown'} - ${latestWarning}`
      : '',
    decision,
  };
}

runHealthCli({
  buildReport,
  formatText,
  errorPrefix: '[reporting 파이프라인 헬스 리포트]',
});
