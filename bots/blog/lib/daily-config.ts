'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');
const { ensureBlogCoreSchema } = require('./schema.ts');

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
    return row || DEFAULT_CONFIG;
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function setConfig(key: DailyConfigKey, value: number | boolean): Promise<Record<string, number | boolean>> {
  const allowed: DailyConfigKey[] = ['lecture_count', 'general_count', 'max_total', 'active'];
  if (!allowed.includes(key)) throw new Error(`허용되지 않은 키: ${key}`);

  const val = key === 'active'
    ? Boolean(value)
    : Math.max(0, Math.min(parseInt(String(value), 10), 4));

  await ensureBlogCoreSchema();
  await pgPool.run('blog', `
    UPDATE blog.daily_config
    SET ${key} = $1, updated_at = NOW()
    WHERE id = (SELECT MAX(id) FROM blog.daily_config)
  `, [val]);

  return { [key]: val };
}

module.exports = { getConfig, setConfig };
