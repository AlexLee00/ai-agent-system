#!/usr/bin/env node
/**
 * session-close.js - 세션 마감 자동화 CLI
 *
 * 사용법:
 *   # Mode A: 문서 패치 + 배포
 *   node scripts/session-close.js \
 *     --bot=reservation \
 *     --title="pickko-daily-summary 일반이용 분리" \
 *     --type=feature \
 *     --items="일반이용 분리 저장|확정 시 room_revenue 반영|midnight 모드" \
 *     --files="lib/db.js,lib/pickko-stats.js,src/pickko-daily-summary.js"
 *
 *   # Mode B: 배포만 (문서는 직접 수정 후)
 *   node scripts/session-close.js --bot=reservation --deploy-only
 *
 *   # Mode C: dry-run (변경 없이 diff 미리보기)
 *   node scripts/session-close.js --bot=reservation --title="..." --dry-run
 *
 *   # Mode D: 전체 봇 배포만
 *   node scripts/session-close.js --all --deploy-only
 */

const path = require('path');
const {
  loadRegistry, getBot, listBots,
  deployBot, deployAll,
  patchDocs,
  parseArgs, validateNote,
  summary,
  log,
} = require('./lib');

const ROOT = path.resolve(__dirname, '..');

// ─── 메인 ────────────────────────────────────────────────────────────────
const { botId, note, flags } = parseArgs(process.argv.slice(2));

// --list: 봇 목록만
if (flags.list) {
  const registry = loadRegistry();
  listBots(registry);
  process.exit(0);
}

// --all --deploy-only: 전체 봇 배포
if (flags.all && flags.deployOnly) {
  const registry = loadRegistry();
  deployAll(registry);
  process.exit(0);
}

// --all 단독: 도움말
if (flags.all) {
  console.log('--all 플래그는 --deploy-only와 함께 사용하세요.');
  console.log('  node scripts/session-close.js --all --deploy-only');
  process.exit(1);
}

// botId 필수
if (!botId) {
  printUsage();
  process.exit(1);
}

const registry = loadRegistry();
let bot;
try {
  bot = getBot(registry, botId);
} catch (e) {
  log(`❌ ${e.message}`);
  process.exit(1);
}

log(`\n🔚 세션 마감: ${bot.name} (${botId})`);

const results = [];

// ─── 문서 패치 ────────────────────────────────────────────────────────────
if (!flags.deployOnly) {
  // 노트 유효성 검사
  try {
    validateNote(note);
  } catch (e) {
    log(`❌ 인수 오류: ${e.message}`);
    printUsage();
    process.exit(1);
  }

  // contextDir 결정
  const contextDir = path.join(ROOT, bot.contextPath);
  // claude-code 타겟에서 memoryDir 추출
  const ccTarget = bot.deployTargets.find(t => t.type === 'claude-code');
  const claudeMemoryDir = ccTarget
    ? ccTarget.workspace.replace('~', process.env.HOME)
    : path.join(process.env.HOME, '.claude', 'projects', '-Users-alexlee', 'memory');

  log(`\n📝 문서 패치 시작... (${flags.dryRun ? 'DRY-RUN' : '실제 쓰기'})`);
  log(`   날짜: ${note.date} | 슬러그: ${note.slug}`);
  log(`   contextDir: ${contextDir}`);
  log(`   memoryDir: ${claudeMemoryDir}`);

  const patchResults = patchDocs(botId, note, {
    contextDir,
    claudeMemoryDir,
    dryRun: flags.dryRun,
  });

  for (const r of patchResults) {
    const statusIcon = { patched: '✅', skipped: '⏭️ ', error: '❌', dry: '🔍' }[r.status] || '  ';
    log(`  ${statusIcon} ${r.file}: ${r.detail}`);
    results.push({ label: r.file, status: r.status === 'patched' ? 'ok' : r.status, msg: r.detail });
  }
}

// ─── 배포 ─────────────────────────────────────────────────────────────────
if (!flags.dryRun) {
  log(`\n🚀 배포 시작: ${botId}`);
  const ok = deployBot(botId, registry);
  results.push({
    label: 'deploy',
    status: ok ? 'ok' : 'error',
    msg: ok ? `${botId} 배포 완료` : `${botId} 배포 실패`,
  });
} else {
  log('\n[dry-run] 배포 스킵 (--dry-run)');
  results.push({ label: 'deploy', status: 'dry', msg: 'dry-run — 실제 배포 없음' });
}

// ─── 요약 출력 ────────────────────────────────────────────────────────────
summary(results);

// ─── 도움말 ───────────────────────────────────────────────────────────────
function printUsage() {
  console.log(`
사용법:
  node scripts/session-close.js \\
    --bot=reservation \\
    --title="기능 제목" \\
    --type=feature \\
    --items="항목1|항목2|항목3" \\
    --files="lib/a.js,src/b.js"

  플래그:
    --deploy-only   문서 패치 없이 배포만 실행
    --dry-run       변경 없이 패치 내용 미리보기
    --all           전체 봇 대상 (--deploy-only 필요)
    --list          봇 목록 출력

  타입: feature | fix | refactor | ops
`);
}
