// @ts-nocheck

const DIRECTIVE_TRANSPORT_KEYS = new Set([
  'createdat',
  'cycleid',
  'directiveid',
  'executedat',
  'signalid',
  'sourceid',
  'timestamp',
]);

function parseObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizedTransportKey(value) {
  return String(value || '').toLowerCase().replace(/[_-]/g, '');
}

export function normalizeDirectiveText(value) {
  return String(value || '').trim().replace(/\s+/gu, ' ');
}

export function stableDirectiveJson(value) {
  if (value == null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableDirectiveJson).join(',')}]`;
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableDirectiveJson(item)}`).join(',')}}`;
}

export function stableDirectiveValue(value, { stripTransport = false } = {}) {
  if (typeof value === 'string') {
    const normalized = normalizeDirectiveText(value);
    if (!normalized) return undefined;
    try {
      return stableDirectiveValue(JSON.parse(normalized), { stripTransport });
    } catch {
      return normalized;
    }
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => stableDirectiveValue(item, { stripTransport }))
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === 'object') {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      if (stripTransport && DIRECTIVE_TRANSPORT_KEYS.has(normalizedTransportKey(key))) continue;
      const child = stableDirectiveValue(value[key], { stripTransport });
      if (child === undefined) continue;
      if (Array.isArray(child) && child.length === 0) continue;
      if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) continue;
      normalized[key] = child;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }
  return value == null ? undefined : value;
}

export function stripDirectiveTransport(value) {
  return stableDirectiveValue(value, { stripTransport: true }) || {};
}

export function directiveSourceKind(row) {
  const meta = parseObject(row?.meta);
  return String(row?.source || meta.sourceKind || row?.type || '').trim().toLowerCase();
}

export function buildDirectiveSemanticProjection(row) {
  const meta = parseObject(row?.meta);
  const payloadCandidate = meta.payload ?? row?.payload;
  const rawPayload = typeof payloadCandidate === 'string' ? parseObject(payloadCandidate) : payloadCandidate;
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) return null;
  const legacyRollbackSpec = (() => {
    if (rawPayload.rollbackSpec != null || rawPayload.rollback_spec != null) return undefined;
    let remainder = normalizeDirectiveText(row?.content || row?.content_preview || '');
    for (const value of [rawPayload.outcome, rawPayload.action, rawPayload.principleCheckResult]) {
      const part = normalizeDirectiveText(
        typeof value === 'string' ? value : stableDirectiveJson(value),
      );
      if (!part || !remainder.startsWith(part)) return undefined;
      remainder = remainder.slice(part.length).trim();
    }
    return remainder ? stableDirectiveValue(remainder, { stripTransport: true }) : undefined;
  })();
  const action = stableDirectiveValue(rawPayload.action);
  const projection = stableDirectiveValue({
    team: meta.team || rawPayload.team || action?.target_team,
    tier: stableDirectiveValue(rawPayload.tier),
    outcome: stableDirectiveValue(rawPayload.outcome),
    action,
    principleCheckResult: stableDirectiveValue(rawPayload.principleCheckResult, { stripTransport: true }),
    rollbackSpec: stableDirectiveValue(
      rawPayload.rollbackSpec ?? rawPayload.rollback_spec ?? legacyRollbackSpec,
      { stripTransport: true },
    ),
  });
  if (!projection || (!projection.outcome && !projection.action && !projection.principleCheckResult)) return null;
  return projection;
}

export function buildDirectiveSemanticBody(row) {
  const projection = buildDirectiveSemanticProjection(row);
  return projection ? JSON.stringify(projection) : null;
}

export function isSigmaDirectiveEntry(row) {
  return directiveSourceKind(row) === 'sigma_directive';
}

export default {
  buildDirectiveSemanticBody,
  buildDirectiveSemanticProjection,
  directiveSourceKind,
  isSigmaDirectiveEntry,
  normalizeDirectiveText,
  stableDirectiveJson,
  stableDirectiveValue,
  stripDirectiveTransport,
};
