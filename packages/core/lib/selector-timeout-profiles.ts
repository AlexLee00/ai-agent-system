import fs from 'node:fs';
import path from 'node:path';

type TimeoutTier = {
  timeoutMs?: number;
  minMs?: number;
  maxMs?: number;
};

type SelectorTimeoutDeclaration = {
  tier?: string;
  timeoutMs?: number;
};

type SelectorTimeoutProfilesConfig = {
  version?: string;
  defaultTier?: string;
  globalDefaultTimeoutMs?: number;
  tiers?: Record<string, TimeoutTier>;
  selectors?: Record<string, SelectorTimeoutDeclaration>;
};

type ResolveOptions = {
  env?: NodeJS.ProcessEnv;
  fallbackTimeoutMs?: number | null;
};

type SelectorTimeoutResolution = {
  enabled: boolean;
  selectorKey: string;
  timeoutMs: number | null;
  tier: string | null;
  source: 'disabled' | 'env' | 'declaration' | 'tier' | 'global_default';
  envName: string | null;
  version: string | null;
  minMs: number | null;
  maxMs: number | null;
};

const CONFIG_PATH = path.resolve(__dirname, '..', 'config', 'selector-timeout-profiles.json');
const DEFAULT_GLOBAL_TIMEOUT_MS = 60_000;

let cachedConfig: SelectorTimeoutProfilesConfig | null = null;

function truthy(value: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function asPositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function clamp(value: number, min: number | null, max: number | null): number {
  let next = Math.floor(value);
  if (min != null) next = Math.max(min, next);
  if (max != null) next = Math.min(max, next);
  return next;
}

function readConfig(): SelectorTimeoutProfilesConfig {
  if (!cachedConfig) {
    cachedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  return cachedConfig;
}

function selectorEnvName(selectorKey: string): string {
  const suffix = String(selectorKey || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `SELECTOR_TIMEOUT_MS_${suffix || 'DEFAULT'}`;
}

function selectorEnvCandidates(selectorKey: string): string[] {
  const names = [selectorEnvName(selectorKey)];
  if (selectorKey === 'claude.archer.tech_analysis') names.push('ARCHER_TIMEOUT_MS');
  return names;
}

function resolveTier(config: SelectorTimeoutProfilesConfig, declaration?: SelectorTimeoutDeclaration | null): { name: string | null; tier: TimeoutTier | null } {
  const tiers = config.tiers || {};
  const name = String(declaration?.tier || config.defaultTier || '').trim();
  if (name && tiers[name]) return { name, tier: tiers[name] };
  return { name: null, tier: null };
}

export function selectorTimeoutProfilesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.SELECTOR_TIMEOUT_PROFILES_ENABLED);
}

export function getSelectorTimeoutProfilesConfig(): SelectorTimeoutProfilesConfig {
  return readConfig();
}

export function getSelectorTimeoutProfilePath(): string {
  return CONFIG_PATH;
}

export function resolveSelectorTimeoutProfile(
  selectorKey: string,
  options: ResolveOptions = {},
): SelectorTimeoutResolution {
  const env = options.env || process.env;
  const key = String(selectorKey || '').trim();
  if (!selectorTimeoutProfilesEnabled(env)) {
    return {
      enabled: false,
      selectorKey: key,
      timeoutMs: asPositiveInt(options.fallbackTimeoutMs) ?? null,
      tier: null,
      source: 'disabled',
      envName: null,
      version: null,
      minMs: null,
      maxMs: null,
    };
  }

  const config = readConfig();
  const declaration = config.selectors?.[key] || null;
  const { name: tierName, tier } = resolveTier(config, declaration);
  const minMs = asPositiveInt(tier?.minMs);
  const maxMs = asPositiveInt(tier?.maxMs);

  for (const envName of selectorEnvCandidates(key)) {
    const envTimeout = asPositiveInt(env[envName]);
    if (envTimeout != null) {
      return {
        enabled: true,
        selectorKey: key,
        timeoutMs: clamp(envTimeout, minMs, maxMs),
        tier: tierName,
        source: 'env',
        envName,
        version: config.version || null,
        minMs,
        maxMs,
      };
    }
  }

  if (!declaration) {
    return {
      enabled: false,
      selectorKey: key,
      timeoutMs: asPositiveInt(options.fallbackTimeoutMs) ?? null,
      tier: null,
      source: 'disabled',
      envName: null,
      version: config.version || null,
      minMs: null,
      maxMs: null,
    };
  }

  const declaredTimeout = asPositiveInt(declaration?.timeoutMs);
  if (declaredTimeout != null) {
    return {
      enabled: true,
      selectorKey: key,
      timeoutMs: clamp(declaredTimeout, minMs, maxMs),
      tier: tierName,
      source: 'declaration',
      envName: null,
      version: config.version || null,
      minMs,
      maxMs,
    };
  }

  const tierTimeout = asPositiveInt(tier?.timeoutMs);
  if (tierTimeout != null) {
    return {
      enabled: true,
      selectorKey: key,
      timeoutMs: clamp(tierTimeout, minMs, maxMs),
      tier: tierName,
      source: declaration ? 'declaration' : 'tier',
      envName: null,
      version: config.version || null,
      minMs,
      maxMs,
    };
  }

  return {
    enabled: true,
    selectorKey: key,
    timeoutMs: asPositiveInt(config.globalDefaultTimeoutMs) || DEFAULT_GLOBAL_TIMEOUT_MS,
    tier: tierName,
    source: 'global_default',
    envName: null,
    version: config.version || null,
    minMs,
    maxMs,
  };
}

export function applySelectorTimeoutProfileToChain<T extends { timeoutMs?: number }>(
  selectorKey: string,
  chain: T[] = [],
  options: ResolveOptions = {},
): T[] {
  const resolution = resolveSelectorTimeoutProfile(selectorKey, {
    ...options,
    fallbackTimeoutMs: options.fallbackTimeoutMs ?? chain[0]?.timeoutMs ?? null,
  });
  if (!resolution.enabled || !resolution.timeoutMs) return chain;
  return chain.map((entry) => ({ ...entry, timeoutMs: resolution.timeoutMs as number }));
}

export function resetSelectorTimeoutProfilesForTest(): void {
  cachedConfig = null;
}
