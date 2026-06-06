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

function text(value, fallback = '') {
  const normalized = String(value == null ? fallback : value).trim();
  return normalized || fallback;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function fileHash(filePath) {
  const normalized = text(filePath);
  if (!normalized) return null;
  const resolved = path.resolve(normalized);
  if (!fs.existsSync(resolved)) return null;
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) return null;
  return sha256(fs.readFileSync(resolved));
}

function detectPoisoning(tool = {}) {
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

function buildToolServerAttestation(tool = {}) {
  const manifest = {
    name: text(tool.name, 'unknown_tool'),
    ownerTeam: text(tool.ownerTeam || tool.team, 'hub'),
    sideEffect: text(tool.sideEffect, 'none'),
    defaultRisk: text(tool.defaultRisk, 'low'),
    requiredTopicLevel: text(tool.requiredTopicLevel, 'L0'),
    executeEnabled: tool.executeEnabled !== false,
    commandPath: text(tool.commandPath || tool.path, ''),
    allowedEnv: Array.isArray(tool.allowedEnv) ? tool.allowedEnv.map((item) => text(item)).filter(Boolean).sort() : [],
    allowedCwd: text(tool.allowedCwd || tool.cwd, ''),
    tools: Array.isArray(tool.tools) ? tool.tools.map((item) => text(item)).filter(Boolean).sort() : [],
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

function validateToolServerAdmission(tool = {}, expected = {}) {
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
