// @ts-nocheck
'use strict';

/**
 * scripts/patch-status.js — 패치 요청 현황 콘솔 출력
 *
 * 사용법: node scripts/patch-status.js
 * 출력: PATCH_REQUEST.md 존재 여부 + 최신 패치 티켓 이력
 */

const fs   = require('fs');
const path = require('path');
const cfg  = require('../lib/archer/config');

function ago(isoStr) {
  if (!isoStr) return '-';
  const diff = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
  if (diff < 60)    return `${diff}초 전`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  return `${Math.floor(diff / 86400)}일 전`;
}

function priorityEmoji(priority) {
  const map = { critical: '🚨', high: '⚠️', medium: '⚡', low: '💡' };
  return map[priority] || '•';
}

function severityEmoji(severity) {
  const map = { critical: '🚨', high: '⚠️', moderate: '⚡', low: '💡' };
  return map[severity] || '•';
}

function main() {
  console.log('\n══════════════════════════════════════');
  console.log('  아처 패치 요청 현황');
  console.log('══════════════════════════════════════\n');

  // 1. PATCH_REQUEST.md 상태
  const patchFile = cfg.OUTPUT.patchRequestFile;
  console.log('▶ PATCH_REQUEST.md');
  if (fs.existsSync(patchFile)) {
    const stat    = fs.statSync(patchFile);
    const content = fs.readFileSync(patchFile, 'utf8');
    const lines   = content.split('\n').length;
    console.log(`  ✅ 존재: ${patchFile}`);
    console.log(`  수정일: ${ago(stat.mtime.toISOString())} | ${lines}줄`);
    // 요약 라인 추출
    const summaryMatch = content.match(/## 주간 요약\n(.*)/);
    if (summaryMatch) {
      console.log(`  요약: ${summaryMatch[1].slice(0, 100)}`);
    }
  } else {
    console.log(`  ❌ 없음 (${patchFile})`);
    console.log('  → node src/archer.js 실행 후 생성됩니다.');
  }

  // 2. 패치 티켓 이력
  console.log('\n▶ 패치 티켓 이력');
  const patchDir = cfg.OUTPUT.patchDir;
  if (!fs.existsSync(patchDir)) {
    console.log('  (패치 디렉토리 없음)');
  } else {
    const files = fs.readdirSync(patchDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, 5);

    if (files.length === 0) {
      console.log('  (없음)');
    }

    for (const file of files) {
      const filePath = path.join(patchDir, file);
      try {
        const ticket = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const stat   = fs.statSync(filePath);
        console.log(`\n  📅 ${ticket.runDate} (${ago(stat.mtime.toISOString())} 생성)`);

        if (ticket.patches?.length > 0) {
          console.log(`  패키지 패치 (${ticket.patches.length}건):`);
          for (const p of ticket.patches) {
            const brk = p.breaking ? ' ⚠️Breaking' : '';
            console.log(`    ${priorityEmoji(p.priority)} ${p.package}: ${p.current} → ${p.latest}${brk}`);
            console.log(`       ${p.reason}`);
          }
        }

        if (ticket.security?.length > 0) {
          console.log(`  보안 취약점 (${ticket.security.length}건):`);
          for (const s of ticket.security) {
            console.log(`    ${severityEmoji(s.severity)} [${s.severity}] ${s.package}: ${s.summary}`);
          }
        }

        if (ticket.llm_api?.length > 0) {
          console.log(`  LLM API 변경 (${ticket.llm_api.length}건):`);
          for (const l of ticket.llm_api) {
            console.log(`    🤖 [${l.provider}] ${l.title}`);
          }
        }

        if (ticket.ai_techniques?.length > 0) {
          console.log(`  AI 기술 트렌드 (${ticket.ai_techniques.length}건):`);
          for (const t of ticket.ai_techniques) {
            console.log(`    🧠 ${t.title}`);
          }
        }

      } catch (e) {
        console.log(`  ${file}: 읽기 오류 (${e.message})`);
      }
    }
  }

  console.log('\n══════════════════════════════════════\n');
}

main();
