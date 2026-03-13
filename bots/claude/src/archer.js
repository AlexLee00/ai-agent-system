'use strict';

/**
 * bots/claude/src/archer.js — 아처 (Archer) 기술 인텔리전스 봇
 *
 * v2.0: AI/LLM 기술 트렌드 서칭 + PATCH_REQUEST.md 패치업 오케스트레이터
 *
 * 실행: node bots/claude/src/archer.js [--telegram] [--no-claude] [--fetch-only]
 *
 * Flags:
 *   --telegram    : 패치 알림을 텔레그램으로 발송
 *   --no-claude   : Claude API 호출 건너뜀 (데이터 수집만)
 *   --fetch-only  : 수집만 하고 분석·저장 생략 (디버그용)
 */

const fs      = require('fs');
const path    = require('path');
const fetcher = require('../lib/archer/fetcher');
const analyzer= require('../lib/archer/analyzer');
const reporter= require('../lib/archer/reporter');
const patcher = require('../lib/archer/patcher');
const store   = require('../lib/archer/store');
const cfg     = require('../lib/archer/config');
const teamBus = require('../lib/team-bus');
const kst     = require('../../../packages/core/lib/kst');

const ARGS       = process.argv.slice(2);
const TELEGRAM   = ARGS.includes('--telegram');
const NO_CLAUDE  = ARGS.includes('--no-claude');
const FETCH_ONLY = ARGS.includes('--fetch-only');

// ── 봇 이름
const BOT_NAME = '아처';

// ─── Lock 파일 관리 ───────────────────────────────────────────────────

function acquireLock() {
  if (fs.existsSync(cfg.OUTPUT.lockFile)) {
    const mtime = fs.statSync(cfg.OUTPUT.lockFile).mtimeMs;
    const ageMs = Date.now() - mtime;
    if (ageMs < 3600 * 1000) {
      console.log(`  ⏳ ${BOT_NAME} 이미 실행 중 — 종료`);
      return false;
    }
    fs.unlinkSync(cfg.OUTPUT.lockFile);
  }
  fs.writeFileSync(cfg.OUTPUT.lockFile, String(process.pid));
  return true;
}

function releaseLock() {
  try { fs.unlinkSync(cfg.OUTPUT.lockFile); } catch { /* 무시 */ }
}

// ─── 로그 기록 ────────────────────────────────────────────────────────

function writeLog(line) {
  const ts = new Date().toISOString();
  try { fs.appendFileSync(cfg.OUTPUT.logFile, `[${ts}] ${line}\n`); } catch { /* 무시 */ }
}

// ─── 버전 추출 (캐시 저장용) ──────────────────────────────────────────

function extractVersions(data) {
  const versions = {};
  for (const [pkg, info] of Object.entries(data.npm || {})) {
    if (info.version) versions[pkg] = info.version;
  }
  return versions;
}

// ─── 메인 ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🏹 ${BOT_NAME} (Archer) 기술 인텔리전스 봇 v2.0 가동\n`);
  writeLog('START');

  if (!acquireLock()) {
    process.exit(0);
  }

  // 팀버스: 시작 상태 등록
  try { teamBus.setStatus('archer', 'running', '기술 트렌드 수집 중'); } catch { /* DB 없으면 무시 */ }

  const start   = Date.now();
  const runDate = kst.today();

  try {
    // 1. 이전 결과 로드 (버전 diff 기준)
    const prev = store.load();

    // 2. 데이터 수집
    const data = await fetcher.fetchAll();

    if (FETCH_ONLY) {
      console.log('\n📊 수집 결과 (--fetch-only 모드):');
      console.log(JSON.stringify({ github: Object.keys(data.github), npm: Object.keys(data.npm), webSources: data.webSources?.length, audit: data.audit?.total }, null, 2));
      writeLog('FETCH_ONLY OK');
      try { teamBus.markDone('archer'); } catch { /* 무시 */ }
      return;
    }

    // 3. Claude 분석
    let analysis = null;
    if (!NO_CLAUDE) {
      console.log('  🤖 [아처] Claude 분석 중...');
      analysis = await analyzer.analyze(data, prev);
    } else {
      console.log('  ⏭️  --no-claude 플래그 — Claude 분석 생략');
      analysis = { patches: [], security: [], llm_api: [], ai_techniques: [], web_highlights: [], summary: '분석 생략 (--no-claude)' };
    }

    // 4. 리포트 저장
    const { filePath } = await reporter.report({ data, analysis, runDate });

    // 5. 패치 티켓 저장 + PATCH_REQUEST.md 생성
    if (analysis) {
      savePatchTickets: {
        try {
          patcher.savePatchTickets(analysis, runDate);
          patcher.savePatchRequest(analysis, runDate);

          // 팀버스: 기술 소화 이력 등록
          for (const src of (data.webSources || [])) {
            for (const item of src.items || []) {
              try {
                teamBus.addTechDigest({
                  runDate,
                  source:  src.id,
                  title:   item.title,
                  version: null,
                  body:    item.link || null,
                });
              } catch { /* 무시 */ }
            }
          }

          // 팀버스: 아처→덱스터 메시지 전송 (패치 있을 때만)
          const patchCount = (analysis.patches || []).length + (analysis.security || []).length;
          if (patchCount > 0) {
            try {
              teamBus.sendMessage(
                'archer', 'dexter', 'patch',
                `주간 패치 요청 (${runDate})`,
                `총 ${patchCount}건 — patches: ${(analysis.patches || []).length}, security: ${(analysis.security || []).length}`
              );
            } catch { /* 무시 */ }
          }
        } catch (e) {
          console.warn(`  ⚠️ [아처] 패치 저장 오류: ${e.message}`);
        }
      }
    }

    // 6. 텔레그램 전송 (patcher 위임)
    if (TELEGRAM && analysis) {
      patcher.sendTelegram(analysis, runDate);
    }

    // 7. 캐시 저장
    const versions = extractVersions(data);
    store.save({
      versions,
      lastRun:  runDate,
      lastAnalysis: analysis && !analysis.error ? {
        summary:       analysis.summary,
        patchCount:    (analysis.patches || []).length,
        securityCount: (analysis.security || []).length,
        llmApiCount:   (analysis.llm_api || []).length,
      } : null,
    });

    // RAG 저장: 기술 분석 결과를 rag_tech에 학습 데이터로 기록
    if (analysis && !analysis.error) {
      try {
        const rag       = require('../../../packages/core/lib/rag-safe');
        const techItems = [
          ...(analysis.patches  || []).slice(0, 3).map(p => `패치: ${p.name || p.package || p.title || '?'}`),
          ...(analysis.security || []).slice(0, 3).map(s => `보안: ${s.title || s.name || '?'}`),
          ...(analysis.llm_api  || []).slice(0, 2).map(l => `LLM: ${l.title || l.name || '?'}`),
        ];
        if (techItems.length > 0) {
          const content = [
            `아처 기술 보고 (${runDate})`,
            techItems.join(' / '),
            analysis.summary ? `요약: ${analysis.summary.slice(0, 100)}` : '',
          ].filter(Boolean).join(' | ');
          await rag.store('tech', content, {
            run_date:       runDate,
            patch_count:    (analysis.patches  || []).length,
            security_count: (analysis.security || []).length,
            llm_api_count:  (analysis.llm_api  || []).length,
            change_type:    'weekly_report',
          }, 'archer');
          console.log(`  [아처] RAG 저장 완료 (tech ${techItems.length}건)`);
        }
      } catch (e) {
        console.warn('[archer] RAG 저장 실패 (무시):', e.message);
      }
    }

    const elapsed = Date.now() - start;
    console.log(`\n✅ ${BOT_NAME} 완료 (총 ${elapsed}ms)`);
    if (filePath) console.log(`📄 리포트: ${filePath}`);
    console.log(`📝 PATCH_REQUEST.md: ${cfg.OUTPUT.patchRequestFile}`);
    writeLog(`OK | ${elapsed}ms | report=${filePath || 'none'}`);

    // 팀버스: 완료 등록
    try { teamBus.markDone('archer'); } catch { /* 무시 */ }

  } catch (e) {
    console.error(`\n❌ ${BOT_NAME} 오류: ${e.message}`);
    writeLog(`ERROR: ${e.message}`);
    try { teamBus.markError('archer', e.message); } catch { /* 무시 */ }
    process.exitCode = 1;
  } finally {
    releaseLock();
  }
}

main();
