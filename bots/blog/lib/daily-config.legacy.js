'use strict';

/**
 * daily-config.js — 일일 발행 수 설정 관리
 */

const pgPool = require('../../../packages/core/lib/pg-pool');

async function getConfig() {
  try {
    const row = await pgPool.get('blog', `
      SELECT lecture_count, general_count, max_total, active
      FROM blog.daily_config
      ORDER BY id DESC LIMIT 1
    `);
    return row || { lecture_count: 1, general_count: 1, max_total: 4, active: true };
  } catch {
    return { lecture_count: 1, general_count: 1, max_total: 4, active: true };
  }
}

/**
 * 설정 변경 (텔레그램 커맨드용)
 * @param {'lecture_count'|'general_count'|'max_total'|'active'} key
 * @param {number|boolean} value
 */
async function setConfig(key, value) {
  const allowed = ['lecture_count', 'general_count', 'max_total', 'active'];
  if (!allowed.includes(key)) throw new Error(`허용되지 않은 키: ${key}`);

  const val = key === 'active'
    ? Boolean(value)
    : Math.max(0, Math.min(parseInt(value), 4));

  await pgPool.run('blog', `
    UPDATE blog.daily_config
    SET ${key} = $1, updated_at = NOW()
    WHERE id = (SELECT MAX(id) FROM blog.daily_config)
  `, [val]);

  return { [key]: val };
}

module.exports = { getConfig, setConfig };
