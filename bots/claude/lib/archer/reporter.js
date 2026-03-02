'use strict';

/**
 * lib/archer/reporter.js — 수집/분석 결과를 마크다운 리포트로 변환 + 저장 + 텔레그램 발송
 */

const fs    = require('fs');
const https = require('https');
const path  = require('path');
const cfg   = require('./config');

// ── 봇 이름 (변경 시 이 상수만 수정)
const BOT_NAME = '아처';

// ─── 마크다운 리포트 빌드 ─────────────────────────────────────────────

function buildMarkdown(data, analysis, prev) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
  const lines = [];

  lines.push(`# ${BOT_NAME} (Archer) 기술 인텔리전스 리포트`);
  lines.push(`> 생성: ${dateStr} | 데이터 수집 ${data.meta.elapsed}ms`);
  lines.push('');

  // ─── Claude 분석 결과 ───────────────────────────────────────────────
  if (analysis && !analysis.error) {
    if (analysis.summary) {
      lines.push('## 이번 주 요약');
      lines.push(analysis.summary);
      lines.push('');
    }

    if (analysis.priority_updates && analysis.priority_updates.length > 0) {
      lines.push('## 우선 업데이트 항목');
      const urgencyIcon = { high: '🔴', medium: '🟡', low: '🟢' };
      for (const u of analysis.priority_updates) {
        const icon = urgencyIcon[u.urgency] || '⚪';
        lines.push(`### ${icon} ${u.package} (${u.urgency})`);
        lines.push(`- **이유**: ${u.reason}`);
        lines.push(`- **권고**: ${u.recommendation}`);
      }
      lines.push('');
    }

    if (analysis.market_insight) {
      lines.push('## 시장 현황 (루나팀 관점)');
      lines.push(analysis.market_insight);
      lines.push('');
    }

    if (analysis.llm_trends) {
      lines.push('## LLM API / 모델 동향');
      lines.push(analysis.llm_trends);
      lines.push('');
    }

    if (analysis.trading_tech) {
      lines.push('## 자동매매 기술 트렌드');
      const items = Array.isArray(analysis.trading_tech)
        ? analysis.trading_tech
        : [analysis.trading_tech];
      for (const item of items) lines.push(`- ${item}`);
      lines.push('');
    }

    if (analysis.action_items && analysis.action_items.length > 0) {
      lines.push('## 즉시 조치 필요');
      for (const item of analysis.action_items) lines.push(`- ⚡ ${item}`);
      lines.push('');
    }
  } else if (analysis?.error) {
    lines.push('## ⚠️ Claude 분석 실패');
    lines.push(`- 오류: ${analysis.error}`);
    lines.push('');
  }

  // ─── 봇 팀 운영 현황 ───────────────────────────────────────────────
  const { luna, ska } = data.bots || {};

  if (luna?.available) {
    lines.push('## 루나팀 운영 현황');
    const lastRun = luna.lastRun ? new Date(luna.lastRun).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : 'N/A';
    lines.push(`- **모드**: ${luna.mode || 'DEV'} | **상태**: ${luna.status || 'idle'} | **총 실행**: ${luna.runCount || 0}회`);
    lines.push(`- **마지막 실행**: ${lastRun} | **연속 오류**: ${luna.consecutiveErrors || 0}회`);
    if (luna.durationMs) lines.push(`- **평균 실행 시간**: ${(luna.durationMs / 1000).toFixed(1)}초`);
    if (luna.signals) {
      const { buy, sell, hold, total } = luna.signals;
      lines.push(`- **최근 신호 (로그 기준)**: BUY ${buy} / SELL ${sell} / HOLD ${hold} (합계 ${total})`);
    }
    lines.push('');
  }

  if (ska?.available) {
    lines.push('## 스카팀 운영 현황');
    const lastRun = ska.lastRun ? new Date(ska.lastRun).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : 'N/A';
    lines.push(`- **상태**: ${ska.status || 'idle'} | **총 점검**: ${ska.checkCount || 0}회 | **마지막**: ${lastRun}`);
    if (ska.consecutiveErrors > 0) lines.push(`- ⚠️ 연속 오류 ${ska.consecutiveErrors}회`);
    if (ska.revenue) {
      const { total7d, studyRoom7d, general7d, days } = ska.revenue;
      lines.push(`- **최근 7일 매출 합계**: ₩${total7d.toLocaleString()}`);
      lines.push(`  - 스터디룸: ₩${studyRoom7d.toLocaleString()} | 일반이용: ₩${general7d.toLocaleString()}`);
      if (days.length > 0) {
        lines.push('- **일별 매출**:');
        for (const d of days) {
          lines.push(`  - ${d.date}: ₩${(d.total || 0).toLocaleString()} (스터디룸 ₩${(d.study_room || 0).toLocaleString()} + 일반 ₩${(d.general || 0).toLocaleString()})`);
        }
      }
    } else if (ska.revenueError) {
      lines.push(`- ⚠️ 매출 데이터 조회 실패: ${ska.revenueError}`);
    }
    lines.push('');
  }

  // ─── 원시 데이터: GitHub Releases ──────────────────────────────────
  lines.push('## GitHub 릴리즈 현황');
  lines.push('| 패키지 | 최신 버전 | 배포일 | 변경 |');
  lines.push('|--------|-----------|--------|------|');
  for (const item of data.github) {
    if (item.error) {
      lines.push(`| ${item.name} | ❌ 수집 실패 | - | - |`);
      continue;
    }
    const prevVer = prev?.versions?.[item.name];
    const changed = prevVer && prevVer !== item.latest ? `${prevVer} → ${item.latest}` : '-';
    lines.push(`| ${item.name} | ${item.latest} | ${item.publishedAt || '-'} | ${changed} |`);
  }
  lines.push('');

  // ─── 원시 데이터: npm ──────────────────────────────────────────────
  lines.push('## npm 패키지 최신 버전');
  lines.push('| 패키지 | 버전 | 게시일 |');
  lines.push('|--------|------|--------|');
  for (const item of data.npm) {
    if (item.error) {
      lines.push(`| ${item.pkg} | ❌ 수집 실패 | - |`);
      continue;
    }
    lines.push(`| ${item.pkg} | ${item.version} | ${item.date || '-'} |`);
  }
  lines.push('');

  // ─── 원시 데이터: 시장 ─────────────────────────────────────────────
  lines.push('## 시장 지수');
  const fg  = data.market.fearGreed;
  const btc = data.market.btc;
  const eth = data.market.eth;

  if (fg && !fg.error) {
    lines.push(`- **공포탐욕지수**: ${fg.current?.value} (${fg.current?.valueText}), 7일 평균: ${fg.avg7d}`);
  }
  if (btc && !btc.error) {
    lines.push(`- **BTC/USDT**: $${btc.price} | 24h: ${btc.change24h}% | 고: $${btc.high24h} | 저: $${btc.low24h}`);
  }
  if (eth && !eth.error) {
    lines.push(`- **ETH/USDT**: $${eth.price} | 24h: ${eth.change24h}% | 고: $${eth.high24h} | 저: $${eth.low24h}`);
  }
  lines.push('');

  lines.push(`---`);
  lines.push(`_${BOT_NAME} 봇 자동 생성 | 분석 소요: ${analysis?.elapsed ?? '-'}ms_`);

  return lines.join('\n');
}

// ─── 텔레그램 요약 빌드 ───────────────────────────────────────────────

function buildTelegramText(analysis, data) {
  const lines = [];
  lines.push(`🏹 *${BOT_NAME} 주간 기술 인텔리전스*`);
  lines.push(`📅 ${new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}`);
  lines.push('');

  if (analysis && !analysis.error) {
    if (analysis.summary) {
      lines.push(`📋 *요약*`);
      lines.push(analysis.summary);
      lines.push('');
    }

    if (analysis.priority_updates && analysis.priority_updates.length > 0) {
      const highItems = analysis.priority_updates.filter(u => u.urgency === 'high');
      if (highItems.length > 0) {
        lines.push('🔴 *긴급 업데이트*');
        for (const u of highItems) {
          lines.push(`  • ${u.package}: ${u.reason}`);
        }
        lines.push('');
      }
    }

    if (analysis.market_insight) {
      lines.push(`📈 *시장 현황*`);
      lines.push(analysis.market_insight);
      lines.push('');
    }

    if (analysis.action_items && analysis.action_items.length > 0) {
      lines.push('⚡ *즉시 조치 필요*');
      for (const item of analysis.action_items) {
        lines.push(`  • ${item}`);
      }
      lines.push('');
    }
  } else {
    lines.push('⚠️ Claude 분석 실패 — 원시 데이터만 수집됨');
    lines.push('');
  }

  // 봇 팀 현황 요약
  const { luna, ska } = data.bots || {};
  if (luna?.available) {
    const signal = luna.signals
      ? `신호 B${luna.signals.buy}/S${luna.signals.sell}/H${luna.signals.hold}`
      : '신호 데이터 없음';
    const errTag = luna.consecutiveErrors > 0 ? ` ⚠️오류${luna.consecutiveErrors}회` : '';
    lines.push(`🌙 *루나팀*: ${luna.mode || 'DEV'} | ${signal}${errTag}`);
  }
  if (ska?.available) {
    const rev = ska.revenue ? `매출 ₩${ska.revenue.total7d.toLocaleString()}(7일)` : '매출 없음';
    const errTag = ska.consecutiveErrors > 0 ? ` ⚠️오류${ska.consecutiveErrors}회` : '';
    lines.push(`☕ *스카팀*: ${rev}${errTag}`);
  }
  if (luna?.available || ska?.available) lines.push('');

  // 시장 지수 요약
  const fg  = data.market.fearGreed;
  const btc = data.market.btc;
  if (fg && !fg.error && btc && !btc.error) {
    lines.push(`_FnG: ${fg.current?.value} (${fg.current?.valueText}) | BTC: $${btc.price} (${btc.change24h}%)_`);
  }

  return lines.join('\n');
}

// ─── 텔레그램 발송 ────────────────────────────────────────────────────

function loadTelegramCreds() {
  const secretPaths = [
    ...cfg.SECRETS_PATHS,
  ];
  for (const p of secretPaths) {
    try {
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (s.telegram_bot_token && s.telegram_chat_id) {
        return { token: s.telegram_bot_token, chatId: s.telegram_chat_id };
      }
    } catch { /* try next */ }
  }
  return null;
}

function sendTelegram(text) {
  const creds = loadTelegramCreds();
  if (!creds) {
    console.warn('  ⚠️ 텔레그램 자격증명 없음 — 알림 생략');
    return Promise.resolve(false);
  }

  const body = Buffer.from(JSON.stringify({
    chat_id:    creds.chatId,
    text,
    parse_mode: 'Markdown',
  }));

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${creds.token}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, res => { res.resume(); res.on('end', () => resolve(true)); });

    req.on('error', () => resolve(false));
    req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ─── 리포트 파일 저장 ─────────────────────────────────────────────────

function saveReport(markdown) {
  try {
    fs.mkdirSync(cfg.OUTPUT.reportDir, { recursive: true });
  } catch { /* ignore */ }

  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filePath = path.join(cfg.OUTPUT.reportDir, `archer-${dateStr}.md`);

  try {
    fs.writeFileSync(filePath, markdown, 'utf8');
    return filePath;
  } catch (e) {
    console.warn(`  ⚠️ 리포트 저장 실패: ${e.message}`);
    return null;
  }
}

// ─── 메인 리포트 함수 ─────────────────────────────────────────────────

async function report(data, analysis, prev, { telegram = false } = {}) {
  const markdown = buildMarkdown(data, analysis, prev);
  const filePath = saveReport(markdown);

  if (filePath) {
    console.log(`  📄 리포트 저장: ${filePath}`);
  }

  if (telegram) {
    const telegramText = buildTelegramText(analysis, data);
    const sent = await sendTelegram(telegramText);
    console.log(sent ? '  📱 텔레그램 발송 완료' : '  ⚠️ 텔레그램 발송 실패');
  }

  return { markdown, filePath };
}

module.exports = { report, buildMarkdown, buildTelegramText, sendTelegram, saveReport };
