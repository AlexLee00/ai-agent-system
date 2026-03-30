'use strict';

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isObject(base) || !isObject(override)) return override ?? base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = isObject(value) && isObject(base[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return merged;
}

function cloneDefaults(defaults) {
  return JSON.parse(JSON.stringify(defaults));
}

function parseConfigFile(fs, filePath, format) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (format === 'yaml') {
    const yaml = require('js-yaml');
    return yaml.load(raw) || {};
  }
  return JSON.parse(raw);
}

function createRuntimeConfigLoader({
  fs,
  defaults,
  configPath,
  format = 'json',
  extractRuntimeConfig = (raw) => raw?.runtime_config || {},
}) {
  let cachedConfig = null;

  function loadRuntimeConfig() {
    if (cachedConfig) return cachedConfig;
    try {
      const parsed = parseConfigFile(fs, configPath, format);
      cachedConfig = deepMerge(defaults, extractRuntimeConfig(parsed) || {});
      return cachedConfig;
    } catch {
      cachedConfig = cloneDefaults(defaults);
      return cachedConfig;
    }
  }

  function resetRuntimeConfigCache() {
    cachedConfig = null;
  }

  return {
    loadRuntimeConfig,
    resetRuntimeConfigCache,
  };
}

module.exports = {
  isObject,
  deepMerge,
  createRuntimeConfigLoader,
};
