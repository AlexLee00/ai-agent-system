'use strict';

/**
 * bots/claude/src/archer.js — 아처 (Archer) 기술 인텔리전스 봇
 *
 * 용도: 매주 기술스택 현황 점검 + 시장 지수 + LLM 동향 분석 후 리포트
 * 실행: node bots/claude/src/archer.js [--telegram] [--no-claude]
 *
 * Flags:
 *   --telegram    : 결과를 텔레그램으로 발송
 *   --no-claude   : Claude API 호출 건너뜀 (데이터 수집만)
 */

const fs      = require('fs');
const path    = require('path');
const fetcher = require('../lib/archer/fetcher');
const analyzer= require('../lib/archer/analyzer');
const reporter= require('../lib/archer/reporter');
const store   = require('../lib/archer/store');
const cfg     = require('../lib/archer/config');

const ARGS       = process.argv.slice(2);
const TELEGRAM   = ARGS.includes('--telegram');
const NO_CLAUDE  = ARGS.includes('--no-claude');

// ── 봇 이름 (변경 시 이 상수만 수정)
const BOT_NAME = '아처';

// ─── Lock 파일 관리 ───────────────────────────────────────────────────

function acquireLock() {
  if (fs.existsSync(cfg.OUTPUT.lockFile)) {
    const mtime = fs.statSync(cfg.OUTPUT.lockFile).mtimeMs;
    const ageMs = Date.now() - mtime;
    if (ageMs < 3600 * 1000) { // 1시간 이내면 실행 중으로 간주
      console.log(`  ⏳ ${BOT_NAME} 이미 실행 중 — 종료`);
      return false;
    }
    fs.unlinkSync(cfg.OUTPUT.lockFile); // stale lock 제거
  }
  fs.writeFileSync(cfg.OUTPUT.lockFile, String(process.pid));
  return true;
}

function releaseLock() {
  try { fs.unlinkSync(cfg.OUTPUT.lockFile); } catch { /* ignore */ }
}

// ─── 로그 기록 ────────────────────────────────────────────────────────

function writeLog(line) {
  const ts = new Date().toISOString();
  try { fs.appendFileSync(cfg.OUTPUT.logFile, `[${ts}] ${line}\n`); } catch { /* ignore */ }
}

// ─── 이전 버전 데이터 추출 ───────────────────────────────────────────

function extractVersions(data) {
  const versions = {};
  for (const item of data.github) {
    if (!item.error) versions[item.name] = item.latest;
  }
  return versions;
}

// ─── 메인 ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🏹 ${BOT_NAME} (Archer) 기술 인텔리전스 봇 가동\n`);
  writeLog('START');

  if (!acquireLock()) {
    process.exit(0);
  }

  const start = Date.now();

  try {
    // 1. 이전 결과 로드 (버전 diff 기준)
    const prev = store.load();

    // 2. 데이터 수집
    const data = await fetcher.fetchAll();

    // 3. Claude 분석
    let analysis = null;
    if (!NO_CLAUDE) {
      analysis = await analyzer.analyze(data, prev);
    } else {
      console.log('  ⏭️  --no-claude 플래그 — 분석 생략');
      analysis = { skipped: true };
    }

    // 4. 리포트 생성 + 저장 + 텔레그램
    const { filePath } = await reporter.report(data, analysis, prev, { telegram: TELEGRAM });

    // 5. 캐시 저장 (다음 실행 시 버전 diff 기준)
    const versions = extractVersions(data);
    store.save({
      versions,
      lastAnalysis: analysis && !analysis.error && !analysis.skipped ? {
        summary:        analysis.summary,
        priority_count: (analysis.priority_updates || []).length,
        action_count:   (analysis.action_items || []).length,
      } : null,
    });

    const elapsed = Date.now() - start;
    console.log(`\n✅ ${BOT_NAME} 완료 (총 ${elapsed}ms)`);
    if (filePath) console.log(`📄 리포트: ${filePath}`);
    writeLog(`OK | ${elapsed}ms | report=${filePath || 'none'}`);

  } catch (e) {
    console.error(`\n❌ ${BOT_NAME} 오류: ${e.message}`);
    writeLog(`ERROR: ${e.message}`);
    process.exitCode = 1;
  } finally {
    releaseLock();
  }
}

main();
