#!/usr/bin/env node
// @ts-nocheck

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { resolvePositionLifecycleFlags } from '../shared/position-lifecycle-flags.ts';
import {
  LUNA_L5_PHASE_KEYS,
  normalizeLifecycleMode,
} from '../shared/luna-l5-operational-gate.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_ROOT = join(__dirname, '..');
const CONFIG_PATH = join(BOT_ROOT, 'config.yaml');
const EXAMPLE_PATH = join(BOT_ROOT, 'config.yaml.example');

function loadYamlFile(path) {
  try {
    if (!existsSync(path)) return { exists: false, data: null, error: null };
    return { exists: true, data: yaml.load(readFileSync(path, 'utf8')) || {}, error: null };
  } catch (error) {
    return { exists: existsSync(path), data: null, error: error?.message || String(error) };
  }
}

function phaseEnabledFromConfig(config = {}, key) {
  const sectionMap = {
    phaseD: 'signal_refresh',
    phaseE: 'dynamic_position_sizing',
    phaseF: 'dynamic_trailing',
    phaseG: 'reflexive_portfolio_monitoring',
    phaseH: 'event_stream',
  };
  const section = config?.position_lifecycle?.[sectionMap[key]] || {};
  return section?.enabled === true;
}

export function buildLunaL5ConfigDoctor({
  configDoc = loadYamlFile(CONFIG_PATH),
  exampleDoc = loadYamlFile(EXAMPLE_PATH),
  flags = resolvePositionLifecycleFlags(),
  targetMode = 'supervised_l4',
} = {}) {
  const target = normalizeLifecycleMode(targetMode);
  const blockers = [];
  const warnings = [];
  const config = configDoc.data || {};
  const example = exampleDoc.data || {};

  if (!exampleDoc.exists) blockers.push('config_example_missing');
  if (exampleDoc.error) blockers.push(`config_example_parse_failed:${exampleDoc.error}`);
  if (!configDoc.exists) warnings.push('config_yaml_missing_using_safe_defaults');
  if (configDoc.error) blockers.push(`config_yaml_parse_failed:${configDoc.error}`);

  if (!config?.position_lifecycle && target === 'autonomous_l5') {
    blockers.push('position_lifecycle_config_missing');
  } else if (!config?.position_lifecycle) {
    warnings.push('position_lifecycle_config_missing');
  }

  if (!example?.position_lifecycle) blockers.push('position_lifecycle_example_missing');

  const configMode = normalizeLifecycleMode(config?.position_lifecycle?.mode || flags.mode || 'shadow');
  if (target === 'autonomous_l5' && configMode !== 'supervised_l4' && configMode !== 'autonomous_l5') {
    blockers.push(`autonomous_target_requires_config_supervised_or_autonomous:${configMode}`);
  }

  const phases = {};
  for (const key of LUNA_L5_PHASE_KEYS) {
    const runtimeEnabled = flags?.[key]?.enabled === true;
    const configEnabled = phaseEnabledFromConfig(config, key);
    phases[key] = { runtimeEnabled, configEnabled };
    if (target === 'autonomous_l5' && runtimeEnabled !== true) blockers.push(`runtime_phase_disabled:${key}`);
    else if (runtimeEnabled !== true) warnings.push(`runtime_phase_disabled:${key}`);
  }

  return {
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'luna_l5_config_doctor_clear' : 'luna_l5_config_doctor_blocked',
    checkedAt: new Date().toISOString(),
    targetMode: target,
    configPresent: configDoc.exists === true,
    examplePresent: exampleDoc.exists === true,
    configMode,
    runtimeMode: flags.mode,
    phases,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    safeSummaryOnly: true,
  };
}

function parseArgs(argv = []) {
  const args = { json: false, targetMode: 'supervised_l4' };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw.startsWith('--target=')) args.targetMode = raw.split('=').slice(1).join('=') || 'supervised_l4';
  }
  return args;
}

function renderText(result = {}) {
  return [
    '🩺 Luna L5 config doctor',
    `status: ${result.status || 'unknown'}`,
    `config: ${result.configPresent ? 'present' : 'missing'} / example: ${result.examplePresent ? 'present' : 'missing'}`,
    `mode: config=${result.configMode || 'unknown'} / runtime=${result.runtimeMode || 'unknown'}`,
    `blockers: ${(result.blockers || []).join(' / ') || 'none'}`,
    `warnings: ${(result.warnings || []).join(' / ') || 'none'}`,
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = buildLunaL5ConfigDoctor({ targetMode: args.targetMode });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-l5-config-doctor 실패:',
  });
}
