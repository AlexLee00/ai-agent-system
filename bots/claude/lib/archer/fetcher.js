'use strict';

/**
 * lib/archer/fetcher.js — 외부 API 데이터 수집
 * Node.js 내장 https만 사용 (외부 의존성 없음)
 * + 내부 봇 상태 수집 (파일 기반, 네트워크 불필요)
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const cfg   = require('./config');

const USER_AGENT = 'ai-agent-system-archer/1.0 (github.com/alexlee/ai-agent-system)';

// ─── 공통 HTTP GET ──────────────────────────────────────────────────

function httpGet(host, path, timeoutMs = 8000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host,
      path,
      method:   'GET',
      headers:  { 'User-Agent': USER_AGENT, ...extraHeaders },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: null, raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ─── GitHub Releases ────────────────────────────────────────────────

async function fetchGithubRelease(name, url) {
  const urlObj = new URL(url);
  try {
    const res = await httpGet(urlObj.hostname, urlObj.pathname, cfg.THRESHOLDS.githubTimeout);
    if (res.status !== 200 || !res.data) return { name, error: `HTTP ${res.status}` };

    const d = res.data;
    return {
      name,
      latest:      d.tag_name || d.name,
      publishedAt: d.published_at ? d.published_at.slice(0, 10) : null,
      url:         d.html_url,
      // 릴리즈 노트 앞 600자만 (텔레그램 길이 제한 고려)
      notes:       (d.body || '').replace(/\r\n/g, '\n').slice(0, 600).trim(),
    };
  } catch (e) {
    return { name, error: e.message };
  }
}

async function fetchAllGithub() {
  const results = await Promise.allSettled(
    Object.entries(cfg.GITHUB).map(([name, url]) => fetchGithubRelease(name, url))
  );
  return results.map(r => r.status === 'fulfilled' ? r.value : { name: '?', error: r.reason?.message });
}

// ─── npm Registry ───────────────────────────────────────────────────

async function fetchNpmVersion(pkg) {
  const encoded = encodeURIComponent(pkg);
  try {
    const res = await httpGet(cfg.NPM.BASE, `/${encoded}/latest`, 6000);
    if (res.status !== 200 || !res.data) return { pkg, error: `HTTP ${res.status}` };
    return {
      pkg,
      version: res.data.version,
      date:    res.data._time ? res.data._time.slice(0, 10) : null,
    };
  } catch (e) {
    return { pkg, error: e.message };
  }
}

async function fetchAllNpm() {
  const results = await Promise.allSettled(
    cfg.NPM.PACKAGES.map(pkg => fetchNpmVersion(pkg))
  );
  return results.map(r => r.status === 'fulfilled' ? r.value : { pkg: '?', error: r.reason?.message });
}

// ─── 시장 데이터 ────────────────────────────────────────────────────

async function fetchFearGreed() {
  try {
    const ep = cfg.MARKET.fearGreed;
    const res = await httpGet(ep.host, ep.path, cfg.THRESHOLDS.marketTimeout);
    if (res.status !== 200 || !res.data?.data) return { error: 'API 응답 없음' };

    const entries = res.data.data.map(e => ({
      value:     Number(e.value),
      valueText: e.value_classification,
      date:      new Date(Number(e.timestamp) * 1000).toISOString().slice(0, 10),
    }));

    return {
      current: entries[0],
      history: entries,
      avg7d:   Math.round(entries.reduce((s, e) => s + e.value, 0) / entries.length),
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function fetchBinanceTicker(symbol, ep) {
  try {
    const res = await httpGet(ep.host, ep.path, cfg.THRESHOLDS.marketTimeout);
    if (res.status !== 200 || !res.data) return { symbol, error: `HTTP ${res.status}` };
    const d = res.data;
    return {
      symbol,
      price:       parseFloat(d.lastPrice).toLocaleString('en-US', { maximumFractionDigits: 2 }),
      priceRaw:    parseFloat(d.lastPrice),
      change24h:   parseFloat(d.priceChangePercent).toFixed(2),
      high24h:     parseFloat(d.highPrice).toLocaleString('en-US', { maximumFractionDigits: 2 }),
      low24h:      parseFloat(d.lowPrice).toLocaleString('en-US', { maximumFractionDigits: 2 }),
      volume:      parseFloat(d.volume).toFixed(0),
    };
  } catch (e) {
    return { symbol, error: e.message };
  }
}

// ─── 루나팀 상태 수집 ─────────────────────────────────────────────────

function fetchLunaStats() {
  const stats = { available: false };

  // 상태 파일 (health.js recordHeartbeat 기록)
  for (const p of ['/tmp/invest-status-dev.json', '/tmp/invest-status.json']) {
    if (!fs.existsSync(p)) continue;
    try {
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      stats.mode          = p.includes('-dev') ? 'DEV' : 'OPS';
      stats.status        = s.status;
      stats.runCount      = s.runCount || 0;
      stats.lastRun       = s.lastRun;
      stats.consecutiveErrors = s.consecutiveErrors || 0;
      stats.durationMs    = s.durationMs;
      stats.available     = true;
      break;
    } catch { /* ignore */ }
  }

  // 최근 로그에서 신호 카운트 (마지막 500줄만)
  const logPath = '/tmp/invest-dev.log';
  if (fs.existsSync(logPath)) {
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      const lines   = content.split('\n');
      const recent  = lines.slice(-500); // 최근 500줄
      let buy = 0, sell = 0, hold = 0;
      for (const line of recent) {
        if      (line.includes('→ 신호: BUY'))  buy++;
        else if (line.includes('→ 신호: SELL')) sell++;
        else if (line.includes('→ 신호: HOLD')) hold++;
      }
      stats.signals = { buy, sell, hold, total: buy + sell + hold };
      stats.available = true;
    } catch { /* ignore */ }
  }

  return stats;
}

// ─── 루나팀 DuckDB 성과 수집 ─────────────────────────────────────────

async function fetchLunaPerformance() {
  const DB_PATH = path.join(cfg.ROOT, 'bots', 'invest', 'db', 'invest.duckdb');
  if (!fs.existsSync(DB_PATH)) return null;

  let db = null;
  let conn = null;
  try {
    const duckdb = require(path.join(cfg.ROOT, 'node_modules', 'duckdb'));
    db   = new duckdb.Database(DB_PATH, duckdb.OPEN_READONLY);
    conn = db.connect();

    const queryAll = (sql, params = []) => new Promise((resolve, reject) => {
      conn.all(sql, ...params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    // 최근 7일 신호 집계 (심볼×액션) — BigInt 방지를 위해 CAST INT 사용
    const signalRows = await queryAll(`
      SELECT symbol, action,
             CAST(COUNT(*) AS INT) AS cnt,
             CAST(AVG(COALESCE(confidence, 0)) AS DOUBLE) AS avg_conf
      FROM signals
      WHERE created_at >= now() - INTERVAL '7 days'
      GROUP BY symbol, action
      ORDER BY symbol, action
    `);

    // 최근 7일 거래 집계 (드라이런 포함)
    const tradeRows = await queryAll(`
      SELECT CAST(COUNT(*) AS INT) AS total,
             CAST(COALESCE(SUM(CASE WHEN side='sell' THEN total_usdt ELSE -total_usdt END), 0) AS DOUBLE) AS pnl
      FROM trades
      WHERE executed_at >= now() - INTERVAL '7 days'
    `);

    // 현재 포지션
    const posRows = await queryAll(`
      SELECT symbol, amount, avg_price, unrealized_pnl, exchange
      FROM positions
      WHERE amount > 0
      ORDER BY symbol
    `);

    // 신호 집계 정리
    const bySymbol = {};
    const byAction = { BUY: 0, SELL: 0, HOLD: 0 };
    for (const row of signalRows) {
      if (!bySymbol[row.symbol]) bySymbol[row.symbol] = { buy: 0, sell: 0, hold: 0, avgConf: 0 };
      const sym = bySymbol[row.symbol];
      if (row.action === 'BUY')  { sym.buy  = row.cnt; byAction.BUY  += row.cnt; }
      if (row.action === 'SELL') { sym.sell = row.cnt; byAction.SELL += row.cnt; }
      if (row.action === 'HOLD') { sym.hold = row.cnt; byAction.HOLD += row.cnt; }
      sym.avgConf = Math.round((row.avg_conf || 0) * 100);
    }

    const td = tradeRows[0] || {};
    return {
      signals7d: {
        total:    byAction.BUY + byAction.SELL + byAction.HOLD,
        bySymbol,
        byAction,
      },
      trades7d: {
        total: td.total || 0,
        pnl:   parseFloat((td.pnl || 0).toFixed(2)),
      },
      positions: posRows.map(p => ({
        symbol:        p.symbol,
        amount:        p.amount,
        avgPrice:      p.avg_price,
        unrealizedPnl: parseFloat((p.unrealized_pnl || 0).toFixed(2)),
        exchange:      p.exchange,
      })),
    };
  } catch (e) {
    return { error: e.message };
  } finally {
    try { conn?.close(); } catch { /* ignore */ }
    try { db?.close();   } catch { /* ignore */ }
  }
}

// ─── 스카팀 상태 수집 ─────────────────────────────────────────────────

function fetchSkaStats() {
  const stats = { available: false };

  // 스카 상태 파일
  const statusPath = '/tmp/ska-status-dev.json';
  if (fs.existsSync(statusPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      stats.checkCount        = s.checkCount || 0;
      stats.lastRun           = s.lastRun;
      stats.consecutiveErrors = s.consecutiveErrors || 0;
      stats.status            = s.status;
      stats.available         = true;
    } catch { /* ignore */ }
  }

  // SQLite room_revenue 최근 7일 매출 (read-only)
  const dbPath = path.join(os.homedir(), '.openclaw', 'workspace', 'state.db');
  if (fs.existsSync(dbPath)) {
    try {
      const Database = require(path.join(cfg.ROOT, 'node_modules', 'better-sqlite3'));
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare(`
        SELECT date,
               SUM(amount) as total,
               SUM(CASE WHEN room != '일반이용' THEN amount ELSE 0 END) as study_room,
               SUM(CASE WHEN room  = '일반이용' THEN amount ELSE 0 END) as general
        FROM room_revenue
        WHERE date >= date('now', '-7 days')
        GROUP BY date
        ORDER BY date DESC
        LIMIT 7
      `).all();
      db.close();
      stats.revenue = {
        days:        rows,
        total7d:     rows.reduce((s, r) => s + (r.total      || 0), 0),
        studyRoom7d: rows.reduce((s, r) => s + (r.study_room || 0), 0),
        general7d:   rows.reduce((s, r) => s + (r.general    || 0), 0),
      };
      stats.available = true;
    } catch (e) {
      stats.revenueError = e.message;
    }
  }

  return stats;
}

// ─── 전체 수집 ──────────────────────────────────────────────────────

async function fetchAll() {
  const start = Date.now();
  console.log('  📡 데이터 수집 중...');

  const [github, npm, fearGreed, btc, eth, lunaPerf] = await Promise.all([
    fetchAllGithub(),
    fetchAllNpm(),
    fetchFearGreed(),
    fetchBinanceTicker('BTC/USDT', cfg.MARKET.btc),
    fetchBinanceTicker('ETH/USDT', cfg.MARKET.eth),
    fetchLunaPerformance(),
  ]);

  // 내부 봇 상태 (동기, 파일 기반)
  const luna = fetchLunaStats();
  // DuckDB 성과 데이터 병합
  if (lunaPerf && !lunaPerf.error) {
    luna.performance = lunaPerf;
  } else if (lunaPerf?.error) {
    luna.performanceError = lunaPerf.error;
  }
  const ska  = fetchSkaStats();

  const elapsed = Date.now() - start;
  console.log(`  ✅ 수집 완료 (${elapsed}ms)`);

  return {
    github,
    npm,
    market: { fearGreed, btc, eth },
    bots:   { luna, ska },
    meta:   { fetchedAt: new Date().toISOString(), elapsed },
  };
}

module.exports = { fetchAll };
