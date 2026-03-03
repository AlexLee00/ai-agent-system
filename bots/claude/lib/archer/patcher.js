'use strict';

/**
 * lib/archer/patcher.js — 패치 티켓 저장 및 PATCH_REQUEST.md 생성
 *
 * 역할:
 *   1. 분석 결과에서 패치 티켓 추출 → reports/patches/ 저장
 *   2. 프로젝트 루트 PATCH_REQUEST.md 자동 생성 (Claude Code가 세션 시작 시 처리)
 *   3. 덱스터에게 텔레그램 알림 전송
 */

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const config  = require('./config');

// ─── 패치 티켓 저장 ──────────────────────────────────────────────────

/**
 * 분석 결과에서 패치 티켓 추출하여 JSON 저장
 * @param {object} analysis  Claude 분석 결과 { patches, security, ... }
 * @param {string} runDate   YYYY-MM-DD
 * @returns {string}  저장된 파일 경로
 */
function savePatchTickets(analysis, runDate) {
  if (!fs.existsSync(config.OUTPUT.patchDir)) {
    fs.mkdirSync(config.OUTPUT.patchDir, { recursive: true });
  }

  const tickets = {
    runDate,
    generatedAt: new Date().toISOString(),
    patches:     analysis.patches     || [],
    security:    analysis.security    || [],
    llm_api:     analysis.llm_api     || [],
    ai_techniques: analysis.ai_techniques || [],
    summary:     analysis.summary     || '',
  };

  const filePath = path.join(config.OUTPUT.patchDir, `${runDate}.json`);
  fs.writeFileSync(filePath, JSON.stringify(tickets, null, 2), 'utf8');
  console.log(`  💾 [아처] 패치 티켓 저장: ${filePath}`);
  return filePath;
}

// ─── PATCH_REQUEST.md 생성 ──────────────────────────────────────────

/**
 * PATCH_REQUEST.md 마크다운 생성
 * @param {object} analysis
 * @param {string} runDate
 * @returns {string}  마크다운 문자열
 */
function buildPatchRequestMd(analysis, runDate) {
  const lines = [];
  const now   = new Date().toISOString().replace('T', ' ').slice(0, 19);

  lines.push(`# PATCH_REQUEST.md`);
  lines.push(`> 아처 자동 생성 — ${runDate} (${now} KST)`);
  lines.push(`> ⚠️ Claude Code 세션 시작 시 자동 처리 대상`);
  lines.push('');

  // 요약
  if (analysis.summary) {
    lines.push('## 주간 요약');
    lines.push(analysis.summary);
    lines.push('');
  }

  // 패키지 패치
  const patches = analysis.patches || [];
  if (patches.length > 0) {
    lines.push('## 패키지 업데이트 요청');
    lines.push('');
    lines.push('| 우선순위 | 패키지 | 현재 | 최신 | Breaking | 이유 |');
    lines.push('|---------|--------|------|------|----------|------|');
    for (const p of patches) {
      const breaking = p.breaking ? '⚠️ YES' : 'NO';
      lines.push(`| ${p.priority} | \`${p.package}\` | ${p.current} | ${p.latest} | ${breaking} | ${p.reason} |`);
    }
    lines.push('');
    lines.push('### 실행 명령');
    lines.push('```bash');
    for (const p of patches.filter(p => p.action)) {
      lines.push(p.action);
    }
    lines.push('```');
    lines.push('');
  }

  // 보안 취약점
  const security = analysis.security || [];
  if (security.length > 0) {
    lines.push('## 보안 취약점 조치 요청');
    lines.push('');
    for (const s of security) {
      const emoji = s.severity === 'critical' ? '🚨' : s.severity === 'high' ? '⚠️' : '⚡';
      lines.push(`### ${emoji} [${s.severity}] \`${s.package}\``);
      lines.push(`- **내용**: ${s.summary}`);
      lines.push(`- **조치**: ${s.action}`);
      lines.push('');
    }
  }

  // LLM API 변경사항
  const llmApi = analysis.llm_api || [];
  if (llmApi.length > 0) {
    lines.push('## LLM API 변경사항');
    lines.push('');
    for (const l of llmApi) {
      lines.push(`### [${l.provider}] ${l.title}`);
      lines.push(`- **영향**: ${l.impact}`);
      lines.push(`- **대응**: ${l.action}`);
      lines.push('');
    }
  }

  // AI 기술 트렌드
  const tech = analysis.ai_techniques || [];
  if (tech.length > 0) {
    lines.push('## AI 기술 트렌드');
    lines.push('');
    for (const t of tech) {
      lines.push(`### ${t.title}`);
      lines.push(`- **출처**: ${t.source}`);
      lines.push(`- **요약**: ${t.summary}`);
      lines.push(`- **적용 가능성**: ${t.applicability}`);
      lines.push('');
    }
  }

  // 웹 하이라이트
  const highlights = analysis.web_highlights || [];
  if (highlights.length > 0) {
    lines.push('## 주간 웹 하이라이트');
    lines.push('');
    for (const h of highlights) {
      lines.push(`- **[${h.source}]** [${h.title}](${h.link}) — ${h.reason}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('> 이 파일은 아처가 자동 생성합니다. 직접 수정 금지.');
  lines.push('> Claude Code가 세션 시작 시 내용을 확인하고 필요한 조치를 취합니다.');

  return lines.join('\n');
}

/**
 * PATCH_REQUEST.md 파일 저장
 * @param {object} analysis
 * @param {string} runDate
 * @returns {string}  파일 경로
 */
function savePatchRequest(analysis, runDate) {
  const md = buildPatchRequestMd(analysis, runDate);
  fs.writeFileSync(config.OUTPUT.patchRequestFile, md, 'utf8');
  console.log(`  📝 [아처] PATCH_REQUEST.md 저장: ${config.OUTPUT.patchRequestFile}`);
  return config.OUTPUT.patchRequestFile;
}

// ─── 텔레그램 알림 ──────────────────────────────────────────────────

function loadTelegramConfig() {
  for (const p of config.SECRETS_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (s?.telegram_bot_token && s?.telegram_chat_id) {
        return { token: s.telegram_bot_token, chatId: s.telegram_chat_id };
      }
    } catch { /* 무시 */ }
  }
  return null;
}

function sendTelegramMsg(token, chatId, text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${token}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(8000, () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

/**
 * 패치 알림 텔레그램 전송
 * @param {object} analysis
 * @param {string} runDate
 */
async function sendTelegram(analysis, runDate) {
  const tg = loadTelegramConfig();
  if (!tg) {
    console.log('  ℹ️ [아처] 텔레그램 미설정 — 알림 스킵');
    return;
  }

  const patches  = analysis.patches  || [];
  const security = analysis.security || [];
  const llmApi   = analysis.llm_api  || [];

  const criticalPatches  = patches.filter(p => p.priority === 'critical' || p.breaking);
  const criticalSecurity = security.filter(s => s.severity === 'critical' || s.severity === 'high');

  const lines = [];
  lines.push(`🏹 <b>아처 주간 리포트</b> (${runDate})`);
  lines.push('');

  if (analysis.summary) {
    lines.push(`📋 ${analysis.summary}`);
    lines.push('');
  }

  if (criticalPatches.length > 0) {
    lines.push(`📦 <b>긴급 패치 (${criticalPatches.length}건)</b>`);
    for (const p of criticalPatches.slice(0, 3)) {
      const brk = p.breaking ? ' ⚠️Breaking' : '';
      lines.push(`  • ${p.package}: ${p.current} → ${p.latest}${brk}`);
    }
    lines.push('');
  }

  if (criticalSecurity.length > 0) {
    lines.push(`🔒 <b>보안 취약점 (${criticalSecurity.length}건)</b>`);
    for (const s of criticalSecurity.slice(0, 3)) {
      lines.push(`  • [${s.severity}] ${s.package}: ${s.summary}`);
    }
    lines.push('');
  }

  if (llmApi.length > 0) {
    lines.push(`🤖 <b>LLM API 변경 (${llmApi.length}건)</b>`);
    for (const l of llmApi.slice(0, 2)) {
      lines.push(`  • [${l.provider}] ${l.title}`);
    }
    lines.push('');
  }

  const totalItems = patches.length + security.length + llmApi.length + (analysis.ai_techniques || []).length;
  lines.push(`📄 PATCH_REQUEST.md 생성됨 (${totalItems}건 항목)`);

  const text = lines.join('\n');
  const ok   = await sendTelegramMsg(tg.token, tg.chatId, text);
  if (ok) {
    console.log('  📲 [아처] 텔레그램 전송 완료');
  } else {
    console.warn('  ⚠️ [아처] 텔레그램 전송 실패');
  }
}

module.exports = {
  savePatchTickets,
  buildPatchRequestMd,
  savePatchRequest,
  sendTelegram,
};
