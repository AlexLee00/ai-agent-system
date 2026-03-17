#!/usr/bin/env node
/**
 * session-close.js - 세션 마감 자동화 CLI
 *
 * 사용법:
 *   # Mode A: 문서 패치 + 배포 + git commit
 *   node scripts/session-close.js \
 *     --bot=orchestrator \
 *     --title="기능 제목" \
 *     --type=feature \
 *     --items="항목1|항목2|항목3" \
 *     --files="router.js,intent-parser.js" \
 *     --git-commit
 *
 *   # Mode B: 자동 (git log에서 title/items 추출)
 *   node scripts/session-close.js --bot=orchestrator --auto --git-commit
 *
 *   # Mode C: 저널 포함
 *   node scripts/session-close.js --bot=orchestrator --auto --git-commit \
 *     --journal-entry="### DEC-NNN | 결정 제목\n\n**배경:** ...\n\n**결정:** ..."
 *
 *   # Mode D: 배포만
 *   node scripts/session-close.js --bot=reservation --deploy-only
 *
 *   # Mode E: dry-run
 *   node scripts/session-close.js --bot=orchestrator --title="..." --dry-run
 *
 *   # Mode F: 전체 봇 배포만
 *   node scripts/session-close.js --all --deploy-only
 *
 * 트리거 키워드 (제이 → 클로드): "세션 마무리", "마감해줘", "정리해줘"
 */

const path = require('path');
const { execSync } = require('child_process');
const {
  loadRegistry, getBot, listBots,
  deployBot, deployAll,
  patchDocs,
  parseArgs, validateNote, todayKST,
  summary,
  log,
} = require('./lib');

const ROOT = path.resolve(__dirname, '..');

// ─── 자동 모드: git log에서 title/items 추출 ────────────────────────────
function autoFromGitLog() {
  try {
    const logRaw = execSync('git log --oneline -10', { cwd: ROOT, encoding: 'utf8' });
    const lines = logRaw.trim().split('\n').filter(l => !l.includes('auto: '));
    if (lines.length === 0) return null;

    // 가장 최근 feat/fix/docs 커밋을 title로
    const featLine = lines.find(l => /^[a-f0-9]+ (feat|fix|refactor|docs|chore)/.test(l)) || lines[0];
    const title = featLine.replace(/^[a-f0-9]+\s+/, '').replace(/^(feat|fix|refactor|docs|chore)(\([^)]+\))?:\s*/, '').trim();

    // 최근 5개 커밋 메시지를 items로
    const items = lines.slice(0, 5).map(l =>
      l.replace(/^[a-f0-9]+\s+/, '').replace(/^(feat|fix|refactor|docs|chore)(\([^)]+\))?:\s*/, '').trim()
    );

    // type 감지
    const type = featLine.startsWith(/^[a-f0-9]+ fix/) ? 'fix'
      : featLine.includes('refactor') ? 'refactor'
      : featLine.includes('ops') ? 'ops'
      : 'feature';

    return { title, items, type };
  } catch {
    return null;
  }
}

// ─── git commit ──────────────────────────────────────────────────────────
function doGitCommit(title) {
  try {
    execSync('git add -A', { cwd: ROOT });
    const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    if (!status.trim()) {
      log('  ℹ️  커밋할 변경 없음 (이미 최신)');
      return true;
    }
    const msg = `docs: 세션 마감 — ${title}\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`;
    execSync(`git commit -m ${JSON.stringify(msg)}`, { cwd: ROOT });
    const hash = execSync('git log --oneline -1', { cwd: ROOT, encoding: 'utf8' }).trim();
    log(`  ✅ git commit: ${hash}`);
    return true;
  } catch (e) {
    log(`  ❌ git commit 실패: ${e.message}`);
    return false;
  }
}

// ─── 메인 ────────────────────────────────────────────────────────────────
const { botId, note, flags } = parseArgs(process.argv.slice(2));

// --list
if (flags.list) {
  const registry = loadRegistry();
  listBots(registry);
  process.exit(0);
}

// --all --deploy-only
if (flags.all && flags.deployOnly) {
  const registry = loadRegistry();
  deployAll(registry);
  process.exit(0);
}

if (flags.all) {
  console.log('--all 플래그는 --deploy-only와 함께 사용하세요.');
  process.exit(1);
}

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

// --auto: git log에서 title/items 자동 추출
if (flags.auto && !note.title) {
  const auto = autoFromGitLog();
  if (auto) {
    note.title = auto.title;
    note.type  = auto.type;
    if (note.items.length === 0) note.items = auto.items;
    note.slug  = note.title.toLowerCase().replace(/[^\w\s가-힣]/g, '').trim().replace(/\s+/g, '-').substring(0, 30);
    log(`  📋 자동 감지: "${note.title}"`);
  } else {
    log('  ⚠️  git log 파싱 실패 — --title 직접 지정 필요');
    process.exit(1);
  }
}

const results = [];

// ─── 문서 패치 ────────────────────────────────────────────────────────────
if (!flags.deployOnly) {
  try {
    validateNote(note);
  } catch (e) {
    log(`❌ 인수 오류: ${e.message}`);
    printUsage();
    process.exit(1);
  }

  const contextDir     = path.join(ROOT, bot.contextPath);
  const ccTarget       = bot.deployTargets.find(t => t.type === 'claude-code');
  const claudeMemoryDir = ccTarget
    ? ccTarget.workspace.replace('~', process.env.HOME)
    : path.join(process.env.HOME, '.claude', 'projects', '-Users-alexlee', 'memory');

  log(`\n📝 문서 패치 시작... (${flags.dryRun ? 'DRY-RUN' : '실제 쓰기'})`);
  log(`   날짜: ${note.date} | 슬러그: ${note.slug}`);

  const docsDir = path.join(ROOT, 'docs');

  const patchResults = patchDocs(botId, note, {
    contextDir,
    claudeMemoryDir,
    docsDir,
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
  log('\n[dry-run] 배포 스킵');
  results.push({ label: 'deploy', status: 'dry', msg: 'dry-run — 실제 배포 없음' });
}

// ─── git commit ───────────────────────────────────────────────────────────
if (flags.gitCommit && !flags.dryRun) {
  log('\n📦 git commit...');
  const ok = doGitCommit(note.title);
  results.push({ label: 'git commit', status: ok ? 'ok' : 'error', msg: ok ? '완료' : '실패' });
}

// ─── 요약 출력 ────────────────────────────────────────────────────────────
summary(results);

// ─── 결과 JSON (claude-commander에서 파싱용) ─────────────────────────────
if (process.env.SESSION_CLOSE_JSON) {
  const ok    = results.every(r => r.status !== 'error');
  const lines = results.map(r => `${r.label}: ${r.status}`);
  process.stdout.write('\n__SESSION_CLOSE_RESULT__' + JSON.stringify({ ok, lines }) + '\n');
}

// ─── 도움말 ───────────────────────────────────────────────────────────────
function printUsage() {
  console.log(`
사용법:
  node scripts/session-close.js \\
    --bot=orchestrator \\
    --title="기능 제목" \\
    --type=feature \\
    --items="항목1|항목2|항목3" \\
    --files="router.js,claude-commander.js" \\
    --git-commit

  플래그:
    --auto          git log에서 title/items 자동 추출
    --git-commit    완료 후 자동 git commit
    --journal-entry="..." RESEARCH_JOURNAL.md에 결정사항 추가
    --deploy-only   문서 패치 없이 배포만 실행
    --dry-run       변경 없이 패치 내용 미리보기
    --all           전체 봇 대상 (--deploy-only 필요)
    --list          봇 목록 출력

  타입: feature | fix | refactor | ops

  트리거 (텔레그램): "세션 마무리" / "마감해줘" / "정리해줘"
`);
}
