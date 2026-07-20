type HealthObservationInput = {
  observerTeam: string;
  resourceId: string;
  failureCount?: number;
};

const RESOURCE_OWNERS: Array<[string, string]> = [
  ['ai.ska.', 'reservation'],
  ['ai.investment.', 'investment'],
  ['ai.luna.', 'investment'],
  ['ai.elixir.', 'investment'],
  ['ai.blog.', 'blog'],
  ['ai.claude.', 'claude'],
  ['ai.hub.', 'hub'],
];

function normalizePart(value: unknown, fallback = 'unknown'): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:/-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || fallback;
}

function normalizeTeam(value: unknown): string {
  const team = normalizePart(value, 'general');
  if (team === 'ska') return 'reservation';
  if (team === 'luna') return 'investment';
  return team;
}

export function ownerTeamForResource(resourceId: unknown, fallbackTeam = 'general'): string {
  const normalized = normalizePart(resourceId);
  return RESOURCE_OWNERS.find(([prefix]) => normalized.startsWith(prefix))?.[1]
    || normalizeTeam(fallbackTeam);
}

export function buildResourceIncidentKey(resourceId: unknown, fallbackTeam = 'general'): string {
  const normalizedResourceId = normalizePart(resourceId);
  const ownerTeam = ownerTeamForResource(normalizedResourceId, fallbackTeam);
  return `${ownerTeam}:service_health:${normalizedResourceId}`;
}

export function buildHealthObservationPolicy({
  observerTeam,
  resourceId,
  failureCount = 1,
}: HealthObservationInput) {
  const normalizedObserverTeam = normalizeTeam(observerTeam);
  const normalizedResourceId = normalizePart(resourceId);
  const ownerTeam = ownerTeamForResource(normalizedResourceId, normalizedObserverTeam);
  const primaryIncidentKey = buildResourceIncidentKey(normalizedResourceId, ownerTeam);
  const normalizedFailureCount = Math.max(1, Math.floor(Number(failureCount) || 1));
  const secondaryObserver = normalizedObserverTeam === 'claude' && ownerTeam === 'reservation';
  const autoRepairEligible = normalizedFailureCount >= 2 && !secondaryObserver;

  return {
    observerTeam: normalizedObserverTeam,
    ownerTeam,
    resourceId: normalizedResourceId,
    failureCount: normalizedFailureCount,
    secondaryObserver,
    autoRepairEligible,
    primaryIncidentKey,
    incidentKey: autoRepairEligible ? primaryIncidentKey : `${primaryIncidentKey}:observation`,
    alarmType: autoRepairEligible ? 'error' : 'work',
    actionability: autoRepairEligible ? 'auto_repair' : 'none',
    visibility: 'internal',
    alertLevel: autoRepairEligible ? 3 : 2,
  };
}
export function buildHealthRecoveryContract({ observerTeam, resourceId }: Omit<HealthObservationInput, 'failureCount'>) {
  const normalizedObserverTeam = normalizeTeam(observerTeam);
  const normalizedResourceId = normalizePart(resourceId);
  const ownerTeam = ownerTeamForResource(normalizedResourceId, normalizedObserverTeam);
  const resolvesIncidentKey = buildResourceIncidentKey(normalizedResourceId, ownerTeam);
  return {
    observerTeam: normalizedObserverTeam,
    ownerTeam,
    resourceId: normalizedResourceId,
    resolvesIncidentKey,
    incidentKey: `${resolvesIncidentKey}:recovery`,
    alarmType: 'work',
    actionability: 'none',
    visibility: 'internal',
    alertLevel: 1,
  };
}
