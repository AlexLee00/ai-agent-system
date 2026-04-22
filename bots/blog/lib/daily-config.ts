'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');
const { ensureBlogCoreSchema } = require('./schema.ts');
const { loadStrategyBundle } = require('./strategy-loader.ts');

type DailyConfigKey = 'lecture_count' | 'general_count' | 'max_total' | 'active';

type DailyConfig = {
  lecture_count: number;
  general_count: number;
  max_total: number;
  active: boolean;
};

const DEFAULT_CONFIG: DailyConfig = {
  lecture_count: 1,
  general_count: 1,
  max_total: 4,
  active: true,
};

async function getConfig(): Promise<DailyConfig> {
  try {
    await ensureBlogCoreSchema();
    const row = await pgPool.get('blog', `
      SELECT lecture_count, general_count, max_total, active
      FROM blog.daily_config
      ORDER BY id DESC LIMIT 1
    `);
    const base = row || DEFAULT_CONFIG;
    const { plan, executionDirectives } = loadStrategyBundle();
    const naverPriority = executionDirectives?.channelPriority?.naverBlog || 'primary';
    const blogRegistrationsPerCycle = Math.max(1, Number(executionDirectives?.executionTargets?.blogRegistrationsPerCycle || 1));
    const titleTone = executionDirectives?.titlePolicy?.tone || 'balanced';
    const lectureCount = Math.max(0, Number(base.lecture_count || DEFAULT_CONFIG.lecture_count || 0));
    const baseGeneralCount = Math.max(0, Number(base.general_count || DEFAULT_CONFIG.general_count || 0));
    const strategyFloor = naverPriority === 'primary' ? blogRegistrationsPerCycle : Math.min(baseGeneralCount || 1, blogRegistrationsPerCycle);
    const amplifyBonus = titleTone === 'amplify' ? 1 : 0;
    const preferredCategoryBonus = plan?.preferredCategory && plan.preferredCategory !== '도서리뷰' ? 1 : 0;
    const generalCount = Math.max(baseGeneralCount, strategyFloor + amplifyBonus + preferredCategoryBonus);
    const maxTotal = Math.max(Number(base.max_total || DEFAULT_CONFIG.max_total || 0), lectureCount + generalCount);
    return {
      lecture_count: lectureCount,
      general_count: generalCount,
      max_total: maxTotal,
      active: Boolean(base.active),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function setConfig(key: DailyConfigKey, value: number | boolean): Promise<Record<string, number | boolean>> {
  const allowed: DailyConfigKey[] = ['lecture_count', 'general_count', 'max_total', 'active'];
  if (!allowed.includes(key)) throw new Error(`허용되지 않은 키: ${key}`);

  const val = key === 'active'
    ? Boolean(value)
    : Math.max(0, Math.min(parseInt(String(value), 10), 8));

  await ensureBlogCoreSchema();
  await pgPool.run('blog', `
    UPDATE blog.daily_config
    SET ${key} = $1, updated_at = NOW()
    WHERE id = (SELECT MAX(id) FROM blog.daily_config)
  `, [val]);

  return { [key]: val };
}

module.exports = { getConfig, setConfig };
