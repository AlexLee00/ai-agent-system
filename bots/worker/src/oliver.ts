// @ts-nocheck
'use strict';
const kst = require('../../../packages/core/lib/kst');
/**
 * bots/worker/src/oliver.js — 올리버 (매출 봇)
 *
 * 기능:
 *   - 매출 CRUD (REST API 경유)
 *   - 일간/주간/월간 집계
 *   - AI 간단 분석
 * 명령어: /sales_today /sales_week /sales_register /sales_analysis
 */

const path   = require('path');
const pgPool = require(path.join(__dirname, '../../../packages/core/lib/pg-pool'));

const SCHEMA  = 'worker';
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

// ── 조회 ──────────────────────────────────────────────────────────────

async function getTodaySales({ companyId }) {
  const today = kst.today();

  const [summary, categories] = await Promise.all([
    pgPool.get(SCHEMA,
      `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt
       FROM worker.sales WHERE company_id=$1 AND date=$2 AND deleted_at IS NULL`,
      [companyId, today]),
    pgPool.query(SCHEMA,
      `SELECT category, SUM(amount) AS amount
       FROM worker.sales WHERE company_id=$1 AND date=$2 AND deleted_at IS NULL
       GROUP BY category ORDER BY amount DESC`,
      [companyId, today]),
  ]);

  return { total: Number(summary?.total ?? 0), count: Number(summary?.cnt ?? 0), categories };
}

async function getWeeklySales({ companyId }) {
  return pgPool.query(SCHEMA,
    `SELECT date, SUM(amount) AS total, COUNT(*) AS cnt
     FROM worker.sales
     WHERE company_id=$1 AND date >= CURRENT_DATE-6 AND deleted_at IS NULL
     GROUP BY date ORDER BY date`,
    [companyId]);
}

async function getMonthlySales({ companyId }) {
  return pgPool.query(SCHEMA,
    `SELECT TO_CHAR(date,'YYYY-MM') AS month,
            SUM(amount) AS total, COUNT(*) AS cnt
     FROM worker.sales
     WHERE company_id=$1 AND date >= CURRENT_DATE-365 AND deleted_at IS NULL
     GROUP BY 1 ORDER BY 1`,
    [companyId]);
}

async function getSalesSummary({ companyId }) {
  const row = await pgPool.get(SCHEMA,
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE date=CURRENT_DATE), 0)          AS today,
       COALESCE(SUM(amount) FILTER (WHERE date>=CURRENT_DATE-6), 0)       AS week,
       COALESCE(SUM(amount) FILTER (WHERE date>=DATE_TRUNC('month',NOW())), 0) AS month
     FROM worker.sales WHERE company_id=$1 AND deleted_at IS NULL`,
    [companyId]);
  return {
    today: Number(row?.today ?? 0),
    week:  Number(row?.week  ?? 0),
    month: Number(row?.month ?? 0),
  };
}

// ── 등록 ──────────────────────────────────────────────────────────────

async function registerSale({ companyId, amount, category, description, registeredBy, date }) {
  const saleDate = date || kst.today();
  return pgPool.get(SCHEMA,
    `INSERT INTO worker.sales (company_id, date, amount, category, description, registered_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, date, amount, category`,
    [companyId, saleDate, amount, category || '기타', description || null, registeredBy || null]);
}

// ── 텔레그램 명령어 핸들러 ────────────────────────────────────────────

async function handleCommand(cmd, args, ctx) {
  const companyId = ctx.user.company_id;

  if (cmd === '/sales_today') {
    const data  = await getTodaySales({ companyId });
    const today = new Date().toLocaleDateString('ko-KR');
    const lines = [
      `💰 <b>오늘 매출</b> (${today})`,
      '───────────────',
      `합계: <b>₩${data.total.toLocaleString()}</b> (${data.count}건)`,
    ];
    if (data.categories.length > 1) {
      lines.push('');
      for (const c of data.categories) {
        lines.push(`  ${c.category || '기타'}: ₩${Number(c.amount).toLocaleString()}`);
      }
    }
    return lines.join('\n');
  }

  if (cmd === '/sales_week') {
    const rows      = await getWeeklySales({ companyId });
    const weekTotal = rows.reduce((s, r) => s + Number(r.total), 0);
    const lines     = [
      '📊 <b>주간 매출 (최근 7일)</b>',
      '───────────────',
      `합계: <b>₩${weekTotal.toLocaleString()}</b>`,
      '',
    ];
    for (const r of rows) {
      const d  = new Date(r.date);
      const wd = WEEKDAY[d.getDay()];
      lines.push(`  ${d.getMonth() + 1}/${d.getDate()}(${wd}): ₩${Number(r.total).toLocaleString()}`);
    }
    if (!rows.length) lines.push('  데이터 없음');
    return lines.join('\n');
  }

  if (cmd === '/sales_register') {
    if (!args) return '사용법: /sales_register {금액} {카테고리}\n예: /sales_register 50000 상품판매';
    const parts    = args.split(' ');
    const amount   = parseInt((parts[0] || '').replace(/[^0-9]/g, ''), 10);
    if (isNaN(amount) || amount <= 0) return '⚠️ 올바른 금액을 입력하세요 (숫자)';
    const category = parts.slice(1).join(' ') || '기타';

    await registerSale({ companyId, amount, category, registeredBy: ctx.user.id });
    return `✅ 매출 등록: ₩${amount.toLocaleString()} (${category})`;
  }

  if (cmd === '/sales_analysis') {
    const rows = await getWeeklySales({ companyId });
    if (!rows.length) return '⚠️ 매출 데이터가 없습니다';

    const totals    = rows.map(r => Number(r.total));
    const weekTotal = totals.reduce((a, b) => a + b, 0);
    const avgDaily  = Math.round(weekTotal / 7);
    const maxRow    = rows.reduce((a, b) => Number(b.total) > Number(a.total) ? b : a, rows[0]);
    const minRow    = rows.reduce((a, b) => Number(b.total) < Number(a.total) ? b : a, rows[0]);

    // 간단 추세 (최근 3일 vs 이전 4일)
    const recent = totals.slice(-3).reduce((a, b) => a + b, 0);
    const prev   = totals.slice(0, -3).reduce((a, b) => a + b, 0);
    const trendIcon = recent >= prev ? '📈 상승' : '📉 하락';

    const lines = [
      '📈 <b>주간 매출 AI 분석</b>',
      '───────────────',
      `주간 합계: <b>₩${weekTotal.toLocaleString()}</b>`,
      `일평균:   ₩${avgDaily.toLocaleString()}`,
      `최고:     ${maxRow.date} (₩${Number(maxRow.total).toLocaleString()})`,
      `최저:     ${minRow.date} (₩${Number(minRow.total).toLocaleString()})`,
      `추세:     ${trendIcon}`,
    ];
    return lines.join('\n');
  }

  return null;
}

module.exports = {
  handleCommand,
  getTodaySales, getWeeklySales, getMonthlySales, getSalesSummary,
  registerSale,
};
