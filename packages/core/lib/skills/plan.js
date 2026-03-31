'use strict';

const kst = require('../kst');

const PLAN_TEMPLATE = {
  title: '',
  requirements: '',
  impactScope: { teams: [], files: [], db: [] },
  risks: [],
  steps: [],
  testStrategy: '',
};

function cloneTemplate() {
  return {
    title: PLAN_TEMPLATE.title,
    requirements: PLAN_TEMPLATE.requirements,
    impactScope: {
      teams: [],
      files: [],
      db: [],
    },
    risks: [],
    steps: [],
    testStrategy: PLAN_TEMPLATE.testStrategy,
  };
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function createPlan(input) {
  const source = input || {};
  const plan = cloneTemplate();

  plan.title = source.title || '';
  plan.requirements = source.requirements || '';
  plan.impactScope.teams = normalizeArray(source.teams || source.impactScope?.teams);
  plan.impactScope.files = normalizeArray(source.files || source.impactScope?.files);
  plan.impactScope.db = normalizeArray(source.db || source.impactScope?.db);
  plan.risks = normalizeArray(source.risks).map((risk) => ({
    desc: risk?.desc || '',
    severity: risk?.severity || 'MEDIUM',
    mitigation: risk?.mitigation || '',
  }));
  plan.steps = normalizeArray(source.steps).map((step, index) => ({
    order: index + 1,
    name: step?.name || '',
    desc: step?.desc || '',
    verification: step?.verification || '',
    files: normalizeArray(step?.files),
  }));
  plan.testStrategy = source.testStrategy || '';
  plan.createdAt = kst.datetimeStr();

  return plan;
}

function validatePlan(plan) {
  const target = plan || {};
  const issues = [];

  if (!target.title) issues.push('제목 누락');
  if (!target.requirements) issues.push('요구사항 누락');
  if (!Array.isArray(target.steps) || target.steps.length === 0) issues.push('구현 단계 누락');
  if (!Array.isArray(target.impactScope?.teams) || target.impactScope.teams.length === 0) {
    issues.push('영향 팀 미지정');
  }
  if (!Array.isArray(target.risks) || target.risks.length === 0) issues.push('위험 요소 미평가');

  return {
    valid: issues.length === 0,
    issues,
  };
}

module.exports = {
  PLAN_TEMPLATE,
  createPlan,
  validatePlan,
};
