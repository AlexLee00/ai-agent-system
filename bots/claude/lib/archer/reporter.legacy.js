'use strict';

/**
 * lib/archer/reporter.js — 수집/분석 결과를 마크다운 리포트로 변환 + 저장
 *
 * v2.0:
 *   - 제거: market/bots 섹션 (시장 데이터, 루나팀/스카팀 통계)
 *   - 추가: patch/audit 섹션, LLM API 변경사항, AI 기술 트렌드, 웹 하이라이트
 *   - 텔레그램 알림: patcher.js에 위임
 */

const fs     = require('fs');
const path   = require('path');
const config   = require('./config');
const analyzer = require('./analyzer');

// ─── 마크다운 리포트 생성 ─────────────────────────────────────────────

function buildMarkdown({ data, analysis, runDate }) {
  const lines = [];
  const now   = new Date().toISOString().replace('T', ' ').slice(0, 19);

  lines.push(`# 아처 주간 기술 인텔리전스 리포트`);
  lines.push(`> 생성: ${runDate} (${now} UTC)`);
  lines.push('');

  // 요약
  if (analysis?.summary) {
    lines.push('## 📋 주간 요약');
    lines.push(analysis.summary);
    lines.push('');
  }

  // 패키지 패치
  const patches = analysis?.patches || [];
  if (patches.length > 0) {
    lines.push('## 📦 패키지 업데이트');
    lines.push('');
    lines.push('| 우선순위 | 패키지 | 현재 | 최신 | Breaking | 이유 |');
    lines.push('|---------|--------|------|------|----------|------|');
    for (const p of patches) {
      const brk = p.breaking ? '⚠️ YES' : 'NO';
      lines.push(`| ${p.priority} | \`${p.package}\` | ${p.current} | ${p.latest} | ${brk} | ${p.reason} |`);
    }
    lines.push('');
  }

  // 보안 취약점
  const security = analysis?.security || [];
  if (security.length > 0) {
    lines.push('## 🔒 보안 취약점');
    lines.push('');
    for (const s of security) {
      const emoji = s.severity === 'critical' ? '🚨' : s.severity === 'high' ? '⚠️' : '⚡';
      lines.push(`### ${emoji} [${s.severity}] \`${s.package}\``);
      lines.push(`- **내용**: ${s.summary}`);
      lines.push(`- **조치**: ${s.action}`);
      lines.push('');
    }
  }

  // npm audit 원시 결과 (분석 없는 경우 대비)
  const audit = data?.audit;
  if (audit && audit.total > 0 && security.length === 0) {
    const s = audit.summary;
    lines.push('## 🔒 npm audit 결과 (원시)');
    lines.push(`- 총 취약점: ${audit.total}개`);
    lines.push(`  critical: ${s.critical || 0}, high: ${s.high || 0}, moderate: ${s.moderate || 0}, low: ${s.low || 0}`);
    lines.push('');
  }

  // LLM API 변경사항
  const llmApi = analysis?.llm_api || [];
  if (llmApi.length > 0) {
    lines.push('## 🤖 LLM API 변경사항');
    lines.push('');
    for (const l of llmApi) {
      lines.push(`### [${l.provider}] ${l.title}`);
      lines.push(`- **영향**: ${l.impact}`);
      lines.push(`- **대응**: ${l.action}`);
      lines.push('');
    }
  }

  // AI 기술 트렌드
  const tech = analysis?.ai_techniques || [];
  if (tech.length > 0) {
    lines.push('## 🧠 AI 기술 트렌드');
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
  const highlights = analysis?.web_highlights || [];
  if (highlights.length > 0) {
    lines.push('## 🌐 주간 웹 하이라이트');
    lines.push('');
    for (const h of highlights) {
      lines.push(`- **[${h.source}]** [${h.title}](${h.link}) — ${h.reason}`);
    }
    lines.push('');
  }

  // GitHub 릴리스 원시 데이터
  if (data?.github) {
    lines.push('## 📡 GitHub 릴리스 현황');
    lines.push('');
    for (const [name, info] of Object.entries(data.github)) {
      if (info.error) {
        lines.push(`- ${name}: ❌ ${info.error}`);
      } else {
        lines.push(`- **${name}**: ${info.tag || '-'} (${info.published?.slice(0, 10) || '-'})`);
      }
    }
    lines.push('');
  }

  // npm 버전 현황
  if (data?.npm) {
    lines.push('## 📦 npm 버전 현황');
    lines.push('');
    for (const [pkg, info] of Object.entries(data.npm)) {
      const ver = info.error ? `❌ ${info.error}` : info.version || '-';
      lines.push(`- ${pkg}: ${ver}`);
    }
    lines.push('');
  }

  // 웹 소스 수집 항목 (상세)
  const webSources = data?.webSources || [];
  if (webSources.some(s => s.items.length > 0)) {
    lines.push('## 🌐 웹 소스 수집');
    for (const src of webSources) {
      if (src.items.length === 0) continue;
      lines.push(`\n### ${src.label}`);
      for (const item of src.items) {
        lines.push(`- [${item.title}](${item.link})${item.pubDate ? ` — ${item.pubDate.slice(0, 10)}` : ''}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── 빌링 트렌드 섹션 삽입 ───────────────────────────────────────────

async function buildMarkdownWithBilling({ data, analysis, runDate }) {
  const base    = buildMarkdown({ data, analysis, runDate });
  const billing = await analyzer.buildBillingTrendSection();
  // 웹 소스 수집 섹션 앞에 삽입 (없으면 끝에 추가)
  const insertBefore = '## 🌐 웹 소스 수집';
  if (base.includes(insertBefore)) {
    return base.replace(insertBefore, billing + '\n' + insertBefore);
  }
  return base + '\n' + billing;
}

// ─── 리포트 저장 ─────────────────────────────────────────────────────

async function saveReport({ data, analysis, runDate }) {
  if (!fs.existsSync(config.OUTPUT.reportDir)) {
    fs.mkdirSync(config.OUTPUT.reportDir, { recursive: true });
  }

  const md       = await buildMarkdownWithBilling({ data, analysis, runDate });
  const fileName = `archer-${runDate}.md`;
  const filePath = path.join(config.OUTPUT.reportDir, fileName);
  fs.writeFileSync(filePath, md, 'utf8');
  console.log(`  📄 [아처] 리포트 저장: ${filePath}`);
  return { filePath, md };
}

// ─── 메인 report 함수 ────────────────────────────────────────────────

/**
 * 리포트 저장 (텔레그램은 patcher.js에서 처리)
 * @param {object} opts { data, analysis, runDate }
 * @returns {object} { filePath, md }
 */
async function report({ data, analysis, runDate }) {
  return saveReport({ data, analysis, runDate });
}

module.exports = { report, buildMarkdown, saveReport };
