type HealthWarning = {
  active?: boolean;
  level?: string;
  reason?: string;
};

type HealthSummaryRow = {
  title?: string;
  summary?: string;
  detail?: string;
  hasWarn?: boolean;
  priority?: number;
};

type HealthSection = {
  title: string;
  lines?: Array<string | null | undefined>;
};

type HealthCounts = {
  okCount?: number;
  warnCount?: number;
  ok?: string[];
  warn?: string[];
};

export function buildHealthHeader(title: string, subtitle = ''): string[] {
  const lines = [title];
  if (subtitle) lines.push(subtitle);
  return lines;
}

export function buildHealthSection(title: string, lines: Array<string | null | undefined> = []): string[] {
  const filtered = (lines || []).filter(Boolean) as string[];
  if (filtered.length === 0) return [];
  return [title, ...filtered];
}

export function buildHealthDecisionSection({
  title = '판단',
  recommended = false,
  level = 'hold',
  reasons = [],
  okText = '현재는 관찰 유지',
}: {
  title?: string;
  recommended?: boolean;
  level?: string;
  reasons?: string[];
  okText?: string;
}): string[] {
  const lines = [title];
  if (recommended) {
    const badge = level === 'high' ? '🔧 즉시 검토' : '🛠 검토 권장';
    lines.push(`  ${badge}`);
  } else {
    lines.push(`  ✅ ${okText}`);
  }
  for (const reason of reasons || []) {
    if (reason) lines.push(`  - ${reason}`);
  }
  return lines;
}

export function buildHealthDecision({
  warnings = [],
  okReason = '현재는 안정 구간입니다.',
}: {
  warnings?: HealthWarning[];
  okReason?: string;
} = {}): { recommended: boolean; level: string; reasons: string[] } {
  const reasons: string[] = [];
  let recommended = false;
  let level = 'hold';

  for (const warning of warnings || []) {
    if (!warning || !warning.active) continue;
    recommended = true;
    if (warning.level === 'high') level = 'high';
    else if (level !== 'high' && warning.level === 'medium') level = 'medium';
    if (warning.reason) reasons.push(warning.reason);
  }

  if (!recommended && okReason) {
    reasons.push(okReason);
  }

  return { recommended, level, reasons };
}

export function buildHealthCountSection(
  title: string,
  health: HealthCounts | null | undefined,
  {
    warnLimit = 8,
    okLimit = 0,
  }: {
    warnLimit?: number;
    okLimit?: number;
  } = {},
): { title: string; lines: string[] } | null {
  if (!health) return null;
  const lines = [
    `  정상 ${Number(health.okCount || 0)}건 / 경고 ${Number(health.warnCount || 0)}건`,
    ...((health.warn || []).slice(0, warnLimit)),
  ];
  if (okLimit > 0) {
    lines.push(...((health.ok || []).slice(0, okLimit)));
  }
  return { title, lines };
}

export function buildHealthSampleSection(
  title: string,
  health: HealthCounts | null | undefined,
  limit = 5,
): { title: string; lines: string[] } | null {
  if (!health || !Array.isArray(health.ok) || health.ok.length === 0) return null;
  return {
    title,
    lines: health.ok.slice(0, limit),
  };
}

export function sortHealthRows<T extends HealthSummaryRow>(
  rows: T[] = [],
  getPriority: (row: T) => number = (row) => Number(row?.priority || 0),
  locale = 'ko',
): T[] {
  return [...rows].sort((a, b) => getPriority(b) - getPriority(a) || String(a?.title || '').localeCompare(String(b?.title || ''), locale));
}

export function buildHealthSummaryLines(
  rows: HealthSummaryRow[] = [],
  {
    warnIcon = '⚠️',
    okIcon = '✅',
  }: {
    warnIcon?: string;
    okIcon?: string;
  } = {},
): string[] {
  return rows.map((row) => `${row.hasWarn ? warnIcon : okIcon} ${row.title}: ${row.summary}`);
}

export function buildHealthDetailLines(rows: HealthSummaryRow[] = []): string[] {
  return rows
    .map((row) => `${row.title}\n${row.detail}`)
    .flatMap((line) => line.split('\n'));
}

export function buildHealthBriefingLines(
  rows: HealthSummaryRow[] = [],
  actionMap: Record<string, string> = {},
  fallbackAction = '/ops-health',
): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(`⚠️ ${row.title}: ${row.summary}`);
    lines.push(`   확인: ${actionMap[row.title || ''] || fallbackAction}`);
  }
  return lines;
}

export function buildHealthReport({
  title,
  subtitle = '',
  sections = [],
  footer = [],
}: {
  title: string;
  subtitle?: string;
  sections?: HealthSection[];
  footer?: Array<string | null | undefined>;
}): string {
  const lines = [...buildHealthHeader(title, subtitle)];
  for (const section of sections) {
    const block = buildHealthSection(section.title, section.lines);
    if (block.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(...block);
  }
  const footerLines = (footer || []).filter(Boolean) as string[];
  if (footerLines.length > 0) {
    lines.push('');
    lines.push(...footerLines);
  }
  return lines.join('\n');
}
