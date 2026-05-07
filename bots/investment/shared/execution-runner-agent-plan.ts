// @ts-nocheck

import fs from 'node:fs';
import path from 'node:path';

function normalizeObject(value = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function cloneObject(value = null) {
  const objectValue = normalizeObject(value);
  if (!objectValue) return null;
  try {
    return JSON.parse(JSON.stringify(objectValue));
  } catch {
    return { ...objectValue };
  }
}

function parseJsonObject(rawValue = '', source = 'agent plan json') {
  try {
    const parsed = JSON.parse(String(rawValue || '').trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('agent plan must be a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`invalid ${source}: ${error?.message || error}`);
  }
}

function readAgentPlanFile(rawPath, cwd = process.cwd()) {
  const filePath = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(cwd, rawPath);
  return parseJsonObject(fs.readFileSync(filePath, 'utf8'), `agent plan file ${filePath}`);
}

function argValue(name, argv = []) {
  const prefix = `${name}=`;
  const found = (argv || []).find((arg) => String(arg || '').startsWith(prefix));
  return found ? String(found).slice(prefix.length) : null;
}

export function readExecutionRunnerAgentPlanArg(argv = process.argv.slice(2), {
  envKey = null,
  cwd = process.cwd(),
} = {}) {
  const rawJson = argValue('--agent-plan-json', argv);
  if (rawJson) return parseJsonObject(rawJson, 'agent plan json');
  const rawFile = argValue('--agent-plan-file', argv);
  if (rawFile) return readAgentPlanFile(rawFile, cwd);
  const envValue = envKey ? String(process.env[envKey] || '').trim() : '';
  if (envValue) return parseJsonObject(envValue, `${envKey} env`);
  return null;
}

export function getCandidateAgentPlan(candidate = null) {
  return normalizeObject(candidate?.agentPlan)
    || normalizeObject(candidate?.executionIntent?.agentPlan)
    || normalizeObject(candidate?.runtimeState?.agentPlan)
    || normalizeObject(candidate?.strategyProfile?.positionRuntimeState?.agentPlan)
    || null;
}

export function buildSignalAgentPlanPayload({
  explicitAgentPlan = null,
  candidate = null,
  runner = null,
} = {}) {
  const selected = normalizeObject(explicitAgentPlan) || getCandidateAgentPlan(candidate);
  const cloned = cloneObject(selected);
  if (!cloned) return null;
  return {
    ...cloned,
    runnerContext: {
      ...(normalizeObject(cloned.runnerContext) || {}),
      runner: runner || null,
      propagatedBy: runner || 'execution_runner',
    },
  };
}

export function serializeAgentPlanArg(agentPlan = null) {
  const objectValue = normalizeObject(agentPlan);
  if (!objectValue) return null;
  return JSON.stringify(objectValue);
}

export default {
  readExecutionRunnerAgentPlanArg,
  getCandidateAgentPlan,
  buildSignalAgentPlanPayload,
  serializeAgentPlanArg,
};
