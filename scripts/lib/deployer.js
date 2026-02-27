/**
 * deployer.js - 봇 컨텍스트 배포 핵심 로직
 * deploy-context.js의 thin wrapper가 이 모듈을 사용합니다.
 */

const fs = require('fs');
const path = require('path');
const { log, expandHome, normalizeFiles } = require('./utils');

const ROOT = path.resolve(__dirname, '..', '..');
const OPENCLAW_CONFIG = path.join(process.env.HOME, '.openclaw', 'openclaw.json');

// openclaw.json에서 실제 실행 중인 primary 모델을 읽음
function readOpenClawPrimaryModel() {
  try {
    const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf-8'));
    return cfg?.agents?.defaults?.model?.primary || null;
  } catch {
    return null;
  }
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
  // BOOT 속도 최적화:
  // - IDENTITY.md + MEMORY.md → 인라인 포함 (별도 LLM 읽기 턴 불필요)
  // - CLAUDE_NOTES.md → 1회 읽기 (행동 지침, 31KB라 인라인 제외)
  // - DEV_SUMMARY.md / HANDOFF.md → BOOT에서 제외 (필요 시 on-demand 참조)
  // - --sync 단계 제거 (BOOT 시 불필요한 1턴 절감)
  // 결과: 7턴(~7분) → 2턴(~2분)
  const INLINE_FILES = ['IDENTITY.md', 'MEMORY.md'];
  const READ_FILES   = ['CLAUDE_NOTES.md'];

  // 인라인 섹션 빌드 (배포된 workspace 파일에서 읽음)
  let inlinedSections = '';
  for (const filename of INLINE_FILES) {
    const filePath = path.join(workspace, filename);
    if (fs.existsSync(filePath)) {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      inlinedSections += `\n\n---\n\n## 📄 ${filename} (인라인)\n\n${fileContent}`;
    }
  }

  const readList = READ_FILES.map((f, i) => `${i + 1}. \`${f}\``).join('\n');

  const content = `# BOOT - ${bot.name}

> 자동 생성 파일 (deploy-context.js). 직접 수정하지 마세요.
> 수정 필요 시: bots/${bot.contextPath.split('/').slice(-2, -1)[0]}/context/ 수정 후 재배포.
${inlinedSections}

---

## 시작 절차

아래 파일 **1개만** 읽으세요 (IDENTITY/MEMORY는 위에 인라인 포함됨):

${readList}

## 봇 정보

| 항목 | 내용 |
|------|------|
| 이름 | ${bot.name} |
| 역할 | ${bot.description} |
| 모델 | ${readOpenClawPrimaryModel() || bot.model?.primary} |
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

// ─── 시스템 현황 자동 업데이트 (클로드 부팅 참조용) ──────────────────────
function updateSystemStatus(deployedBotId, registry) {
  // claude-code 타겟이 있는 봇에서 워크스페이스 경로 추출
  let claudeWorkspace = null;
  for (const bot of Object.values(registry.bots)) {
    const t = bot.deployTargets.find(t => t.type === 'claude-code');
    if (t) { claudeWorkspace = expandHome(t.workspace); break; }
  }
  if (!claudeWorkspace) return;

  const statusFile = path.join(claudeWorkspace, 'SYSTEM_STATUS.md');
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  // 기존 배포 이력 보존
  let history = [];
  if (fs.existsSync(statusFile)) {
    const existing = fs.readFileSync(statusFile, 'utf-8');
    const m = existing.match(/<!-- history-start -->([\s\S]*?)<!-- history-end -->/);
    if (m) history = m[1].trim().split('\n').filter(l => l.trim());
  }
  const deployed = registry.bots[deployedBotId];
  const targets = deployed.deployTargets.map(t => t.type).join('+') || '-';
  history.unshift(`- ${now} — **${deployedBotId}** (${deployed.name}) [${targets}]`);
  if (history.length > 10) history = history.slice(0, 10);

  // 봇 현황 테이블
  const emoji = { ops: '✅', dev: '🔧', planned: '⏳' };
  const rows = Object.entries(registry.bots).map(([id, b]) => {
    const oc = b.deployTargets.find(t => t.type === 'openclaw');
    const loginType = oc ? `${oc.type}/${oc.loginType}` : (b.deployTargets[0]?.type || '-');
    return `| ${emoji[b.status] || '❓'} | \`${id}\` | ${b.name} | ${b.model?.primary || '-'} | ${loginType} |`;
  }).join('\n');

  const content = `# 시스템 현황 — 클로드 부팅 참조

> \`deploy-context.js\` 실행 시 자동 업데이트. 직접 수정 금지.
> 마지막 업데이트: ${now}

---

## 봇 배포 현황

| 상태 | 봇ID | 이름 | 모델 | 로그인 방식 |
|------|------|------|------|------------|
${rows}

---

## 최근 배포 이력 (최신 10건)

<!-- history-start -->
${history.join('\n')}
<!-- history-end -->

---

## 클로드 주요 경로

| 항목 | 경로 |
|------|------|
| 봇 컨텍스트 | \`~/projects/ai-agent-system/bots/<봇ID>/context/\` |
| 배포 명령 | \`node scripts/deploy-context.js --bot=<봇ID>\` |
| 스카 OPS 로그 | \`/tmp/naver-ops-mode.log\` |
| OpenClaw 워크스페이스 | \`~/.openclaw/workspace/\` |
| 클로드 메모리 | \`~/.claude/projects/-Users-alexlee/memory/\` |
`;

  fs.writeFileSync(statusFile, content);
  log(`  📊 SYSTEM_STATUS.md 업데이트`);
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
  updateSystemStatus(botId, registry);
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

// ─── 전체 배포 ────────────────────────────────────────────────────────────
function deployAll(registry) {
  log('🚀 전체 봇 배포 시작...');
  for (const botId of Object.keys(registry.bots)) {
    deployBot(botId, registry);
  }
  log('\n✅ 전체 배포 완료');
}

module.exports = { deployBot, syncBot, deployAll, updateSystemStatus };
