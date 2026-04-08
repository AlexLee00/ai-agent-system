type PlainObject = Record<string, unknown>;

type LoaderFs = {
  readFileSync(filePath: string, encoding: string): string;
};

type RuntimeConfigLoaderOptions<TDefaults extends PlainObject, TRaw = unknown> = {
  fs: LoaderFs;
  defaults: TDefaults;
  configPath: string;
  format?: 'json' | 'yaml';
  extractRuntimeConfig?: (raw: TRaw) => Partial<TDefaults>;
};

export function isObject(value: unknown): value is PlainObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (!isObject(base) || !isObject(override)) return (override ?? base) as T;
  const merged: PlainObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = isObject(value) && isObject((base as PlainObject)[key])
      ? deepMerge((base as PlainObject)[key], value)
      : value;
  }
  return merged as T;
}

export function cloneDefaults<T>(defaults: T): T {
  return JSON.parse(JSON.stringify(defaults)) as T;
}

function parseConfigFile(fs: LoaderFs, filePath: string, format: 'json' | 'yaml'): unknown {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (format === 'yaml') {
    const yaml = require('js-yaml') as { load(input: string): unknown };
    return yaml.load(raw) || {};
  }
  return JSON.parse(raw) as unknown;
}

export function createRuntimeConfigLoader<TDefaults extends PlainObject, TRaw = unknown>({
  fs,
  defaults,
  configPath,
  format = 'json',
  extractRuntimeConfig = (raw) => ((raw as { runtime_config?: Partial<TDefaults> } | null | undefined)?.runtime_config || {}),
}: RuntimeConfigLoaderOptions<TDefaults, TRaw>): {
  loadRuntimeConfig(): TDefaults;
  resetRuntimeConfigCache(): void;
} {
  let cachedConfig: TDefaults | null = null;

  function loadRuntimeConfig(): TDefaults {
    if (cachedConfig) return cachedConfig;
    try {
      const parsed = parseConfigFile(fs, configPath, format) as TRaw;
      cachedConfig = deepMerge(defaults, extractRuntimeConfig(parsed) || {});
      return cachedConfig;
    } catch {
      cachedConfig = cloneDefaults(defaults);
      return cachedConfig;
    }
  }

  function resetRuntimeConfigCache(): void {
    cachedConfig = null;
  }

  return {
    loadRuntimeConfig,
    resetRuntimeConfigCache,
  };
}
