// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const kst = require('../../../packages/core/lib/kst');

const STRATEGY_DIR = path.join(env.PROJECT_ROOT, 'bots/blog/output/strategy');

function ensureStrategyDir() {
  if (!fs.existsSync(STRATEGY_DIR)) fs.mkdirSync(STRATEGY_DIR, { recursive: true });
}

function createStrategyPlan(diagnosis = {}) {
  const topCategory = diagnosis.byCategory?.[0]?.key || null;
  const topPattern = diagnosis.byTitlePattern?.[0]?.key || null;

  const focus = [];
  if (diagnosis.primaryWeakness?.code === 'category_bias' && topCategory) {
    focus.push(`다음 주에는 ${topCategory} 외 카테고리 우선 편성`);
  }
  if (diagnosis.primaryWeakness?.code === 'title_pattern_bias' && topPattern) {
    focus.push(`${topPattern} 패턴 비중 축소, 경험형/체크리스트형 강화`);
  }
  if (!focus.length) {
    focus.push('현재 분포 유지, 제목 패턴만 순환 테스트');
  }

  return {
    evolvedAt: new Date().toISOString(),
    weekOf: kst.today(),
    weakness: diagnosis.primaryWeakness,
    focus,
    recommendations: diagnosis.recommendations || [],
    preferredCategory: diagnosis.byCategory?.[1]?.key || diagnosis.byCategory?.[0]?.key || null,
    suppressedCategory: diagnosis.byCategory?.[0]?.key || null,
    preferredTitlePattern: diagnosis.byTitlePattern?.find((item) => item.key !== diagnosis.byTitlePattern?.[0]?.key)?.key || diagnosis.byTitlePattern?.[0]?.key || null,
    suppressedTitlePattern: diagnosis.byTitlePattern?.[0]?.key || null,
  };
}

async function evolveStrategy(diagnosis = {}, options = {}) {
  const plan = createStrategyPlan(diagnosis);
  if (options.dryRun) {
    return {
      saved: false,
      latestPath: null,
      datedPath: null,
      plan,
    };
  }

  ensureStrategyDir();
  const latestPath = path.join(STRATEGY_DIR, 'latest-strategy.json');
  const datedPath = path.join(STRATEGY_DIR, `${kst.today()}_strategy.json`);
  const payload = {
    diagnosis,
    plan,
  };

  fs.writeFileSync(latestPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(datedPath, JSON.stringify(payload, null, 2), 'utf8');

  return {
    saved: true,
    latestPath,
    datedPath,
    plan,
  };
}

module.exports = {
  evolveStrategy,
  createStrategyPlan,
};
