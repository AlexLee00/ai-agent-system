// Secret Metadata helper. Never returns raw values, only presence and shape metadata.

export const SECRET_KEY_EXACT = new Set([
  'token', 'secret', 'password', 'pw', 'key',
  'api_key', 'access_token', 'refresh_token', 'oc',
]);

const SECRET_KEY_SUFFIXES = [
  '_token', '_secret', '_password', '_pw', '_key', '_oc',
];

export const REQUIRED_FIELDS: Record<string, string[]> = {
  justin: ['korea_law.user_id', 'korea_law.user_name', 'korea_law.oc'],
  openai_oauth: ['access_token'],
  telegram: ['bot_token'],
};

type Dict = Record<string, unknown>;

type FieldMeta = {
  present?: boolean;
  kind: string;
  count?: number;
  field_count?: number;
  primitive_types?: string[];
  fields?: Record<string, FieldMeta>;
  element_schema?: FieldMeta | null;
  element_keys?: string[];
};

export function isSecretKey(key: string): boolean {
  const lower = String(key || '').toLowerCase();
  if (SECRET_KEY_EXACT.has(lower)) return true;
  return SECRET_KEY_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function isPresentScalar(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function mergeRepresentativeField(base: unknown, next: unknown): unknown {
  if (base === undefined) return next;
  if (!isPresentScalar(base) && isPresentScalar(next)) return next;
  return base;
}

function buildArrayElementSchema(values: unknown[]): FieldMeta | null {
  const nonNull = values.filter((item) => item !== undefined && item !== null);
  if (nonNull.length === 0) return null;

  const objectItems = nonNull.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) as Dict[];
  if (objectItems.length > 0) {
    const representative: Dict = {};
    for (const item of objectItems) {
      for (const [key, value] of Object.entries(item)) {
        representative[key] = mergeRepresentativeField(representative[key], value);
      }
    }
    const fields: Record<string, FieldMeta> = {};
    for (const [key, value] of Object.entries(representative)) {
      fields[key] = buildFieldMeta(key, value);
    }
    return { kind: 'nested', field_count: Object.keys(fields).length, fields };
  }

  const primitiveTypes = new Set(nonNull.map((item) => (Array.isArray(item) ? 'array' : typeof item)));
  if (primitiveTypes.size === 1) {
    const [single] = Array.from(primitiveTypes);
    if (single === 'array') {
      const firstArray = nonNull.find(Array.isArray);
      return { kind: 'array', count: Array.isArray(firstArray) ? firstArray.length : 0 };
    }
    return { kind: single };
  }

  return { kind: 'mixed', primitive_types: Array.from(primitiveTypes).sort() };
}

export function buildFieldMeta(key: string, value: unknown): FieldMeta {
  if (Array.isArray(value)) {
    const meta: FieldMeta = { present: value.length > 0, kind: 'array', count: value.length };
    const elementSchema = buildArrayElementSchema(value);
    if (elementSchema) {
      meta.element_schema = elementSchema;
      if (elementSchema.kind === 'nested' && elementSchema.fields) {
        meta.element_keys = Object.keys(elementSchema.fields);
      }
    }
    return meta;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Dict);
    const fields: Record<string, FieldMeta> = {};
    for (const [childKey, childValue] of entries) {
      fields[childKey] = buildFieldMeta(childKey, childValue);
    }
    return { present: entries.length > 0, kind: 'nested', field_count: entries.length, fields };
  }
  const kind = isSecretKey(key) ? 'secret' : 'config';
  const present = isPresentScalar(value);
  return { present, kind };
}

export function buildCategoryMeta(data: Dict): Record<string, FieldMeta> {
  const result: Record<string, FieldMeta> = {};
  for (const [key, value] of Object.entries(data || {})) {
    result[key] = buildFieldMeta(key, value);
  }
  return result;
}

function getNestedValue(data: unknown, dotPath: string): unknown {
  const parts = dotPath.split('.');
  let current = data;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Dict)[part];
  }
  return current;
}

export function buildRequiredSummary(category: string, data: Dict): { missing: string[]; present: string[] } | null {
  const required = REQUIRED_FIELDS[category];
  if (!required) return null;
  const missing: string[] = [];
  const present: string[] = [];
  for (const dotPath of required) {
    const value = getNestedValue(data, dotPath);
    (isPresentScalar(value) ? present : missing).push(dotPath);
  }
  return { missing, present };
}

function hasPresentSecretMeta(meta: FieldMeta | null | undefined): boolean {
  if (!meta || typeof meta !== 'object') return false;
  if (meta.kind === 'secret' && meta.present === true) return true;
  if (meta.kind === 'nested' && meta.fields) {
    return Object.values(meta.fields).some((child) => hasPresentSecretMeta(child));
  }
  if (meta.kind === 'array' && meta.element_schema) {
    return hasPresentSecretMeta(meta.element_schema);
  }
  return false;
}

export function summarizeCategoryCompleteness(category: string, data: Dict | null | undefined) {
  const source = data && typeof data === 'object' ? data : {};
  const fields = buildCategoryMeta(source);
  const required = buildRequiredSummary(category, source);
  const secretPresent = Object.values(fields).some((meta) => hasPresentSecretMeta(meta));

  const requiredPresent = required ? required.present.length : null;
  const requiredMissing = required ? required.missing.length : null;
  const requiredTotal = required ? requiredPresent! + requiredMissing! : null;

  const present = required ? requiredPresent! > 0 : secretPresent;
  const ready = required ? requiredMissing === 0 : secretPresent;

  return {
    present,
    ready,
    field_count: Object.keys(source).length,
    secret_present: secretPresent,
    required_total: requiredTotal,
    required_present: requiredPresent,
    required_missing: requiredMissing,
  };
}
