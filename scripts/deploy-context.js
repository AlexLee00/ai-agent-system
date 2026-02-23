#!/usr/bin/env node
/**
 * deploy-context.js - 봇 컨텍스트 배포 스크립트
 *
 * 사용법:
 *   node deploy-context.js --list                        봇 목록 확인
 *   node deploy-context.js --bot=reservation             특정 봇 배포 (전체 타겟)
 *   node deploy-context.js --bot=reservation --target=openclaw    특정 타겟만 배포
 *   node deploy-context.js --all                         전체 봇 배포
 *   node deploy-context.js --bot=reservation --sync      워크스페이스 → context/ 역동기화
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_FILE = path.join(ROOT, 'bots', 'registry.json');

function log(msg) {
  const t = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${t}] ${msg}`);
}

function expandHome(p) {
  return p.startsWith('~') ? p.replace('~', process.env.HOME) : p;
}

function loadRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
}

// files 항목을 { src, dest } 형태로 정규화
// 문자열 "FOO.md"     → { src: "FOO.md", dest: "FOO.md" }
// 객체  { src, dest } → 그대로
function normalizeFiles(files) {
  return files.map(f => (typeof f === 'string' ? { src: f, dest: f } : f));
}

// ─── openclaw 배포 ────────────────────────────────────────────────────────
function deployOpenclaw(bot, botId, target, contextDir) {
  const workspace = expandHome(target.workspace);
  log(`\n  📦 [openclaw] → ${workspace}`);

  if (!fs.existsSync(workspace)) {
    fs.mkdirSync(workspace, { recursive: true });
    log(`  📁 워크스페이스 생성`);
  }

  for (const { src, dest } of normalizeFiles(target.files)) {
    const srcPath = path.join(contextDir, src);
    const destPath = path.join(workspace, dest);
    if (!fs.existsSync(srcPath)) { log(`  ⚠️  없음(스킵): ${src}`); continue; }
    fs.copyFileSync(srcPath, destPath);
    log(`  ✅ ${src} → ${dest} (${fs.statSync(destPath).size}B)`);
  }

  if (target.bootFile) {
    generateOpenclawBoot(bot, botId, target, workspace);
  }
}

function generateOpenclawBoot(bot, botId, target, workspace) {
  const fileList = normalizeFiles(target.files)
    .map(({ dest }, i) => `${i + 1}. \`${dest}\``)
    .join('\n');

  const content = `# BOOT - ${bot.name}

> 자동 생성 파일 (deploy-context.js). 직접 수정하지 마세요.
> 수정 필요 시: bots/${bot.contextPath.split('/').slice(-2, -1)[0]}/context/ 수정 후 재배포.

## 시작 절차

### 1단계: 이전 세션 컨텍스트 보존 (파일 읽기 전 먼저 실행)

아래 명령을 실행하여 이전 모델의 워크스페이스 변경사항을 context/에 저장하세요:

\`\`\`bash
node ~/projects/ai-agent-system/scripts/deploy-context.js --bot=${botId} --sync
\`\`\`

### 2단계: 파일 순서대로 읽기

${fileList}

## 봇 정보

| 항목 | 내용 |
|------|------|
| 이름 | ${bot.name} |
| 역할 | ${bot.description} |
| 모델 | ${bot.model?.primary} |
| 상태 | ${bot.status} |

학습 완료 후 텔레그램으로 준비 완료 메시지를 보내세요.
`;
  fs.writeFileSync(path.join(workspace, target.bootFile), content);
  log(`  🔄 ${target.bootFile} 자동 생성`);
}

// ─── claude-code 배포 ─────────────────────────────────────────────────────
function deployClaudeCode(bot, botId, target, contextDir) {
  const workspace = expandHome(target.workspace);
  log(`\n  📦 [claude-code] → ${workspace}`);

  if (!fs.existsSync(workspace)) {
    fs.mkdirSync(workspace, { recursive: true });
    log(`  📁 메모리 디렉토리 생성`);
  }

  // 토픽 파일 복사
  for (const { src, dest } of normalizeFiles(target.files)) {
    const srcPath = path.join(contextDir, src);
    const destPath = path.join(workspace, dest);
    if (!fs.existsSync(srcPath)) { log(`  ⚠️  없음(스킵): ${src}`); continue; }
    fs.copyFileSync(srcPath, destPath);
    log(`  ✅ ${src} → ${dest} (${fs.statSync(destPath).size}B)`);
  }

  // MEMORY.md 에 봇 참조 섹션 추가/업데이트
  if (target.memoryFile) {
    updateClaudeCodeMemory(bot, botId, target, workspace);
  }
}

function updateClaudeCodeMemory(bot, botId, target, workspace) {
  const memoryPath = path.join(workspace, target.memoryFile);
  if (!fs.existsSync(memoryPath)) {
    log(`  ⚠️  ${target.memoryFile} 없음 - 참조 섹션 추가 스킵`);
    return;
  }

  let content = fs.readFileSync(memoryPath, 'utf-8');

  // 봇별 섹션 마커
  const sectionStart = `<!-- bot:${botId}:start -->`;
  const sectionEnd   = `<!-- bot:${botId}:end -->`;

  const topicLinks = normalizeFiles(target.files)
    .map(({ dest }) => `→ memory/${dest}`)
    .join('\n');

  const newSection = `${sectionStart}
## 🤖 ${bot.name} (${botId}) 컨텍스트

${topicLinks}

_최근 배포: ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}_
${sectionEnd}`;

  // 기존 섹션 교체 or 파일 끝에 추가
  if (content.includes(sectionStart)) {
    const re = new RegExp(`${sectionStart}[\\s\\S]*?${sectionEnd}`, 'g');
    content = content.replace(re, newSection);
    log(`  🔄 ${target.memoryFile} 봇 섹션 업데이트`);
  } else {
    content = content.trimEnd() + '\n\n' + newSection + '\n';
    log(`  ➕ ${target.memoryFile} 봇 섹션 추가`);
  }

  fs.writeFileSync(memoryPath, content);
}

// ─── 배포 진입점 ──────────────────────────────────────────────────────────
function deployBot(botId, registry, targetTypeFilter = null) {
  const bot = registry.bots[botId];
  if (!bot) {
    log(`❌ 봇 없음: ${botId} (등록된 봇: ${Object.keys(registry.bots).join(', ')})`);
    return false;
  }

  if (bot.deployTargets.length === 0) {
    log(`⏳ [${botId}] deployTargets 없음 (${bot.status}) - 스킵`);
    return true;
  }

  const contextDir = path.join(ROOT, bot.contextPath);
  if (!fs.existsSync(contextDir)) {
    log(`❌ [${botId}] context 디렉토리 없음: ${contextDir}`);
    return false;
  }

  log(`\n🤖 봇: ${bot.name} (${botId}) | 상태: ${bot.status} | 모델: ${bot.model?.primary}`);

  for (const target of bot.deployTargets) {
    if (targetTypeFilter && target.type !== targetTypeFilter) continue;

    if (target.type === 'openclaw') {
      deployOpenclaw(bot, botId, target, contextDir);
    } else if (target.type === 'claude-code') {
      deployClaudeCode(bot, botId, target, contextDir);
    } else {
      log(`  ⚠️  [${target.type}] 미지원 타입 - 스킵 (향후 추가 예정)`);
    }
  }

  log(`\n  ✅ [${botId}] 배포 완료`);
  return true;
}

// ─── 역동기화: 워크스페이스 → context/ ───────────────────────────────────
function syncBot(botId, registry) {
  const bot = registry.bots[botId];
  if (!bot || bot.deployTargets.length === 0) {
    log(`❌ [${botId}] 동기화 대상 없음`);
    return false;
  }

  const contextDir = path.join(ROOT, bot.contextPath);
  log(`\n🔄 역동기화: ${botId} (워크스페이스 → context/)`);

  for (const target of bot.deployTargets) {
    const workspace = expandHome(target.workspace);
    log(`\n  📥 [${target.type}] ${workspace}`);

    for (const { src, dest } of normalizeFiles(target.files)) {
      const srcPath = path.join(workspace, dest);   // 워크스페이스의 dest 파일
      const destPath = path.join(contextDir, src);  // context/의 src 파일로 복원

      if (!fs.existsSync(srcPath)) { log(`  ⚠️  없음(스킵): ${dest}`); continue; }
      fs.copyFileSync(srcPath, destPath);
      log(`  ✅ ${dest} → context/${src}`);
    }
  }

  log(`\n  ✅ [${botId}] 역동기화 완료`);
  return true;
}

// ─── 목록 출력 ────────────────────────────────────────────────────────────
function listBots(registry) {
  log('\n📋 등록된 봇 목록:\n');
  for (const [id, bot] of Object.entries(registry.bots)) {
    const emoji = { ops: '✅', dev: '🔧', planned: '⏳' }[bot.status] || '❓';
    const targets = bot.deployTargets.map(t => t.type).join(', ') || '없음';
    console.log(`  ${emoji} ${id.padEnd(14)} ${bot.name.padEnd(20)} [${bot.status}] → ${targets}`);
    console.log(`     ${bot.description}`);
    console.log(`     모델: ${bot.model?.primary}`);
    console.log('');
  }
}

// ─── 메인 ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const botArg    = args.find(a => a.startsWith('--bot='))?.split('=')[1];
const targetArg = args.find(a => a.startsWith('--target='))?.split('=')[1];
const isAll     = args.includes('--all');
const isSync    = args.includes('--sync');
const isList    = args.includes('--list');

const registry = loadRegistry();

if (isList) {
  listBots(registry);
} else if (isSync && botArg) {
  syncBot(botArg, registry);
} else if (botArg) {
  deployBot(botArg, registry, targetArg || null);
} else if (isAll) {
  log('🚀 전체 봇 배포 시작...');
  for (const botId of Object.keys(registry.bots)) {
    deployBot(botId, registry);
  }
  log('\n✅ 전체 배포 완료');
} else {
  console.log(`
사용법:
  node scripts/deploy-context.js --list
  node scripts/deploy-context.js --bot=reservation
  node scripts/deploy-context.js --bot=reservation --target=openclaw
  node scripts/deploy-context.js --bot=reservation --target=claude-code
  node scripts/deploy-context.js --all
  node scripts/deploy-context.js --bot=reservation --sync
`);
}
