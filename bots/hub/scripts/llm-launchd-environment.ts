type Environment = NodeJS.ProcessEnv;

const SELECTOR_ENV_PREFIXES = Object.freeze([
  'LLM_',
  'HUB_',
  'SELECTOR_',
  'LUNA_',
  'ARCHER_',
]);

export function isSelectorEnvironmentKey(key: string): boolean {
  return SELECTOR_ENV_PREFIXES.some((prefix) => String(key || '').startsWith(prefix));
}

export function applyAuthoritativeLaunchdEnvironment(
  launchdEnv: Record<string, unknown>,
  options: { env?: Environment; managedKeys?: string[] } = {},
): { injected: string[]; overridden: string[]; cleared: string[] } {
  const targetEnv = options.env || process.env;
  const managedKeys = Array.isArray(options.managedKeys) ? options.managedKeys : [];
  const ambientSelectorKeys = Object.keys(targetEnv).filter(isSelectorEnvironmentKey);
  const keys = [...new Set([...managedKeys, ...ambientSelectorKeys, ...Object.keys(launchdEnv)])].sort();
  const injected: string[] = [];
  const overridden: string[] = [];
  const cleared: string[] = [];

  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(launchdEnv, key)) {
      if (targetEnv[key] !== undefined) {
        delete targetEnv[key];
        cleared.push(key);
      }
      continue;
    }

    const value = String(launchdEnv[key]);
    if (targetEnv[key] === undefined) injected.push(key);
    else if (targetEnv[key] !== value) overridden.push(key);
    targetEnv[key] = value;
  }

  return { injected, overridden, cleared };
}
