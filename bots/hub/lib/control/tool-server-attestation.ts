const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const POISONING_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?(previous|system)\s+instructions/i,
  /reveal\s+(the\s+)?(system\s+)?prompt/i,
  /exfiltrat(e|ion)/i,
  /send\s+.*\bsecret(s)?\b/i,
  /bypass\s+(policy|guard|permission|approval)/i,
  /disable\s+(security|guard|audit|logging)/i,
];

type ToolServerDefinition = {
  name?: string;
  description?: unknown;
  schema?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  instructions?: unknown;
  ownerTeam?: string;
  team?: string;
  sideEffect?: string;
  defaultRisk?: string;
  requiredTopicLevel?: string;
  executeEnabled?: boolean;
  commandPath?: string;
  path?: string;
  allowedEnv?: unknown[];
  allowedCwd?: string;
  cwd?: string;
  tools?: unknown[];
  attestationId?: string;
  [key: string]: unknown;
};
type ExpectedAttestation = {
  attestationId?: string;
};
type ToolServerManifest = {
  name: string;
  ownerTeam: string;
  sideEffect: string;
  defaultRisk: string;
  requiredTopicLevel: string;
  executeEnabled: boolean;
  commandPath: string;
  allowedEnv: string[];
  allowedCwd: string;
  tools: string[];
  schemaHash: string;
  outputSchemaHash: string;
  descriptionHash: string;
  instructionsHash: string;
};
type ToolServerAttestation = {
  ok: true;
  attestationId: string;
  manifest: ToolServerManifest;
  scriptHash: string | null;
};

function text(value: unknown, fallback = ''): string {
  const normalized = String(value == null ? fallback : value).trim();
  return normalized || fallback;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function fileHash(filePath: unknown): string | null {
  const normalized = text(filePath);
  if (!normalized) return null;
  const resolved = path.resolve(normalized);
  if (!fs.existsSync(resolved)) return null;
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) return null;
  return sha256(fs.readFileSync(resolved));
}

function detectPoisoning(tool: ToolServerDefinition = {}): string | null {
  const haystack = [
    tool.name,
    tool.description,
    tool.schema,
    tool.inputSchema,
    tool.outputSchema,
    tool.instructions,
  ].map((part) => (typeof part === 'string' ? part : stableJson(part || null))).join('\n');
  const pattern = POISONING_PATTERNS.find((candidate) => candidate.test(haystack));
  return pattern ? pattern.source : null;
}

function buildToolServerAttestation(tool: ToolServerDefinition = {}): ToolServerAttestation {
  const manifest: ToolServerManifest = {
    name: text(tool.name, 'unknown_tool'),
    ownerTeam: text(tool.ownerTeam || tool.team, 'hub'),
    sideEffect: text(tool.sideEffect, 'none'),
    defaultRisk: text(tool.defaultRisk, 'low'),
    requiredTopicLevel: text(tool.requiredTopicLevel, 'L0'),
    executeEnabled: tool.executeEnabled !== false,
    commandPath: text(tool.commandPath || tool.path, ''),
    allowedEnv: Array.isArray(tool.allowedEnv) ? tool.allowedEnv.map((item: unknown) => text(item)).filter(Boolean).sort() : [],
    allowedCwd: text(tool.allowedCwd || tool.cwd, ''),
    tools: Array.isArray(tool.tools) ? tool.tools.map((item: unknown) => text(item)).filter(Boolean).sort() : [],
    schemaHash: sha256(stableJson(tool.schema || tool.inputSchema || {})),
    outputSchemaHash: sha256(stableJson(tool.outputSchema || {})),
    descriptionHash: sha256(text(tool.description, '')),
    instructionsHash: sha256(stableJson(tool.instructions || '')),
  };
  const scriptHash = manifest.commandPath ? fileHash(manifest.commandPath) : null;
  const attestationId = sha256(stableJson({ ...manifest, scriptHash }));
  return {
    ok: true,
    attestationId,
    manifest,
    scriptHash,
  };
}

function validateToolServerAdmission(tool: ToolServerDefinition = {}, expected: ExpectedAttestation = {}) {
  const poisoningPattern = detectPoisoning(tool);
  if (poisoningPattern) {
    return {
      ok: false,
      error: 'mcp_poisoning_pattern_detected',
      detail: poisoningPattern,
      attestation: buildToolServerAttestation(tool),
    };
  }

  const attestation = buildToolServerAttestation(tool);
  const expectedId = text(expected.attestationId || tool.attestationId, '');
  if (expectedId && expectedId !== attestation.attestationId) {
    return {
      ok: false,
      error: 'tool_server_attestation_mismatch',
      expectedAttestationId: expectedId,
      actualAttestationId: attestation.attestationId,
      attestation,
    };
  }

  const commandPath = text(tool.commandPath || tool.path, '');
  if (commandPath && !attestation.scriptHash) {
    return {
      ok: false,
      error: 'tool_server_command_not_attestable',
      commandPath,
      attestation,
    };
  }

  return {
    ok: true,
    attestation,
  };
}

module.exports = {
  POISONING_PATTERNS,
  buildToolServerAttestation,
  validateToolServerAdmission,
  _testOnly: {
    stableJson,
    sha256,
    detectPoisoning,
  },
};
