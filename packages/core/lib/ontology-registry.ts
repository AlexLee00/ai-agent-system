'use strict';

export const ONTOLOGY_ACTION_TYPES = [
  { id: 'alarm.resolve', objectType: 'alarm', description: 'Resolve an alarm through its existing lifecycle contract.' },
  { id: 'brief.publish', objectType: 'brief', description: 'Publish a prepared brief.' },
  { id: 'gate.evaluate', objectType: 'gate', description: 'Evaluate an existing approval or quality gate.' },
  { id: 'prediction.evaluate', objectType: 'prediction', description: 'Evaluate a recorded prediction against its outcome.' },
  { id: 'report.publish', objectType: 'report', description: 'Publish a prepared report.' },
  { id: 'task.report_progress', objectType: 'task', description: 'Report progress for an existing task.' },
] as const;

export const ONTOLOGY_OBJECT_TYPES = [
  {
    id: 'position',
    label: 'Position',
    aliases: ['position', 'portfolio_position', 'position_snapshot', 'trade_position'],
    actions: [],
  },
  {
    id: 'brief',
    label: 'Brief',
    aliases: ['brief', 'briefing', 'daily_brief', 'weekly_brief'],
    actions: ['brief.publish'],
  },
  {
    id: 'prediction',
    label: 'Prediction',
    aliases: ['forecast', 'prediction', 'prediction_ledger'],
    actions: ['prediction.evaluate'],
  },
  {
    id: 'alarm',
    label: 'Alarm',
    aliases: ['alarm', 'alert', 'incident_alarm'],
    actions: ['alarm.resolve'],
  },
  {
    id: 'task',
    label: 'Task',
    aliases: ['bridge_task', 'task', 'work_item'],
    actions: ['task.report_progress'],
  },
  {
    id: 'report',
    label: 'Report',
    aliases: ['auto_dev_outcome', 'outcome', 'refactor_outcome', 'report', 'result_report'],
    actions: ['report.publish'],
  },
  {
    id: 'gate',
    label: 'Gate',
    aliases: ['approval_gate', 'gate', 'promotion_gate', 'quality_gate'],
    actions: ['gate.evaluate'],
  },
] as const;

export type OntologyObjectTypeId = typeof ONTOLOGY_OBJECT_TYPES[number]['id'];
export type OntologyActionTypeId = typeof ONTOLOGY_ACTION_TYPES[number]['id'];

const OBJECT_TYPE_IDS = ONTOLOGY_OBJECT_TYPES.map(({ id }) => id);
const ACTION_TYPE_IDS = ONTOLOGY_ACTION_TYPES.map(({ id }) => id);

export const ONTOLOGY_REGISTRY = Object.freeze({
  version: 'o1-v1',
  objectTypes: ONTOLOGY_OBJECT_TYPES,
  actionTypes: ONTOLOGY_ACTION_TYPES,
});

export const ONTOLOGY_REGISTRY_JSON_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://ai-agent.local/schemas/ontology-registry-o1-v1.json',
  title: 'AI Agent Lightweight Ontology Registry',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'objectTypes', 'actionTypes'],
  properties: {
    version: { const: 'o1-v1' },
    objectTypes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'aliases', 'actions'],
        properties: {
          id: { type: 'string', enum: OBJECT_TYPE_IDS },
          label: { type: 'string', minLength: 1 },
          aliases: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
          actions: { type: 'array', items: { type: 'string', enum: ACTION_TYPE_IDS }, uniqueItems: true },
        },
      },
    },
    actionTypes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'objectType', 'description'],
        properties: {
          id: { type: 'string', enum: ACTION_TYPE_IDS },
          objectType: { type: 'string', enum: OBJECT_TYPE_IDS },
          description: { type: 'string', minLength: 1 },
        },
      },
    },
  },
});

function normalizeTypeName(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const OBJECT_TYPE_BY_ALIAS = new Map(ONTOLOGY_OBJECT_TYPES.flatMap((type) => (
  [type.id, ...type.aliases].map((alias) => [normalizeTypeName(alias), type] as const)
)));

export function resolveOntologyObjectType(...values: unknown[]) {
  for (const value of values.flatMap((candidate) => (Array.isArray(candidate) ? candidate : [candidate]))) {
    const resolved = OBJECT_TYPE_BY_ALIAS.get(normalizeTypeName(value));
    if (resolved) return resolved;
  }
  return null;
}

module.exports = {
  ONTOLOGY_ACTION_TYPES,
  ONTOLOGY_OBJECT_TYPES,
  ONTOLOGY_REGISTRY,
  ONTOLOGY_REGISTRY_JSON_SCHEMA,
  resolveOntologyObjectType,
};
