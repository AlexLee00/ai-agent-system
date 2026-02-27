#!/usr/bin/env node
'use strict';

/**
 * bug-report.js — 스카 버그 추적 & 유지보수 기록 CLI
 *
 * 변경 시마다 HANDOFF.md 버그/유지보수 섹션이 자동으로 갱신됩니다.
 *
 * 사용법:
 *   node bug-report.js --new         --title "제목" [--desc "설명"] [--severity critical|high|medium|low]
 *                                    [--by ska|claude] [--category stability|logic|ux|data|reliability]
 *                                    [--files "src/a.js,src/b.js"]
 *
 *   node bug-report.js --action      --id BUG-001 --desc "조치 내용"
 *                                    [--type investigate|fix|workaround|verify|note]
 *                                    [--by ska|claude]
 *
 *   node bug-report.js --resolve     --id BUG-001 [--desc "해결 요약"] [--by claude]
 *
 *   node bug-report.js --list        [--status open|in_progress|resolved|all]
 *
 *   node bug-report.js --show        --id BUG-001
 *
 *   node bug-report.js --maintenance --title "제목" [--type config|fix|feature|refactor|deploy|hotfix]
 *                                    [--desc "설명"] [--by claude]
 *                                    [--bugs "BUG-001,BUG-002"] [--files "src/a.js,src/b.js"]
 *
 *   node bug-report.js --maint-list  [--limit 10]
 */

const fs   = require('fs');
const path = require('path');
const { parseArgs } = require('../lib/args');

const WORKSPACE    = process.env.OPENCLAW_WORKSPACE
  || path.join(process.env.HOME, '.openclaw', 'workspace');
const TRACKER_FILE = path.join(WORKSPACE, 'bug-tracker.json');
// HANDOFF.md는 workspace 복사본이 아닌 소스 파일을 직접 수정
// → deploy-context.js가 덮어쓰는 순서 의존성 제거
const HANDOFF_FILE = path.join(__dirname, '..', 'context', 'HANDOFF.md');

// ─── 저장소 ────────────────────────────────────────────────────────────

function loadTracker() {
  if (!fs.existsSync(TRACKER_FILE)) {
    return { version: '1.0', lastUpdated: null, bugs: [], maintenance: [] };
  }
  return JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf-8'));
}

function saveTracker(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(TRACKER_FILE, JSON.stringify(data, null, 2), 'utf-8');
  syncHandoff(data);   // 저장 시마다 HANDOFF.md 자동 갱신
}

function nextId(list, prefix) {
  const nums = list
    .map(e => parseInt(e.id.replace(`${prefix}-`, ''), 10))
    .filter(n => !isNaN(n));
  const next = nums.length === 0 ? 1 : Math.max(...nums) + 1;
  return `${prefix}-${String(next).padStart(3, '0')}`;
}

// ─── 표시 헬퍼 ────────────────────────────────────────────────────────

const STATUS_ICON = { open: '🔴', in_progress: '🟡', resolved: '✅', wontfix: '⬛' };
const SEV_ICON    = { critical: '🚨', high: '🔴', medium: '🟡', low: '🟢' };
const TYPE_ICON   = { config: '⚙️', fix: '🔧', feature: '✨', refactor: '♻️', deploy: '🚀', hotfix: '🚑' };

function ageText(ts) {
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins >= 1440) return `${Math.floor(mins / 1440)}일 전`;
  if (mins >= 60)   return `${Math.floor(mins / 60)}시간 전`;
  return `${mins}분 전`;
}

function shortTs(ts) {
  return new Date(ts).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
}

// ─── HANDOFF.md 자동 갱신 ─────────────────────────────────────────────
// HANDOFF.md 내 마커 사이 내용을 버그/유지보수 현황으로 자동 교체합니다.
// 마커: <!-- bug-tracker:issues:start --> ... <!-- bug-tracker:issues:end -->
//       <!-- bug-tracker:maintenance:start --> ... <!-- bug-tracker:maintenance:end -->

function syncHandoff(data) {
  if (!fs.existsSync(HANDOFF_FILE)) return;

  let content = fs.readFileSync(HANDOFF_FILE, 'utf-8');

  // ── 이슈 섹션: 미해결 + 최근 해결 ──────────────────────────────────
  const openBugs = data.bugs.filter(b => b.status === 'open' || b.status === 'in_progress');
  const recentResolved = [...data.bugs]
    .filter(b => b.status === 'resolved')
    .sort((a, b) => new Date(b.resolvedAt) - new Date(a.resolvedAt))
    .slice(0, 3);

  let issueBlock = '';

  if (openBugs.length === 0) {
    issueBlock += '_현재 미해결 이슈 없음_\n';
  } else {
    issueBlock += '| 상태 | 심각도 | ID | 제목 | 발견자 | 경과 |\n';
    issueBlock += '|------|--------|----|------|--------|------|\n';
    for (const b of openBugs) {
      issueBlock += `| ${STATUS_ICON[b.status]} | ${SEV_ICON[b.severity] || b.severity} | \`${b.id}\` | ${b.title} | ${b.detectedBy} | ${ageText(b.detectedAt)} |\n`;
    }
  }

  if (recentResolved.length > 0) {
    issueBlock += '\n**최근 해결:**\n';
    for (const b of recentResolved) {
      const last = b.actions[b.actions.length - 1];
      issueBlock += `- ✅ \`${b.id}\` **${b.title}**\n`;
      issueBlock += `  ${last?.description || ''} (${ageText(b.resolvedAt)})\n`;
    }
  }

  content = replaceSection(content, 'issues', issueBlock.trimEnd());

  // ── 유지보수 섹션: 최근 8건 ───────────────────────────────────────
  const recentMaint = [...data.maintenance]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 8);

  let maintBlock = '';

  if (recentMaint.length === 0) {
    maintBlock = '_유지보수 기록 없음_\n';
  } else {
    for (const m of recentMaint) {
      const bugs  = m.relatedBugIds.length ? ` *(→ ${m.relatedBugIds.join(', ')})*` : '';
      const files = m.files.length ? ` · \`${m.files.join('`, `')}\`` : '';
      maintBlock += `- ${TYPE_ICON[m.type] || '🔧'} \`${m.id}\` [${m.type}] **${m.title}**${bugs}\n`;
      maintBlock += `  ${shortTs(m.timestamp)} · ${m.appliedBy}${files}\n`;
    }
  }

  content = replaceSection(content, 'maintenance', maintBlock.trimEnd());

  fs.writeFileSync(HANDOFF_FILE, content, 'utf-8');
}

function replaceSection(content, key, newBody) {
  const startMark = `<!-- bug-tracker:${key}:start -->`;
  const endMark   = `<!-- bug-tracker:${key}:end -->`;
  const si = content.indexOf(startMark);
  const ei = content.indexOf(endMark);
  if (si === -1 || ei === -1) return content;   // 마커 없으면 변경 안 함
  return (
    content.slice(0, si + startMark.length) +
    '\n' + newBody + '\n' +
    content.slice(ei)
  );
}

// ─── 커맨드 구현 ──────────────────────────────────────────────────────

function cmdNew(args) {
  if (!args.title) { console.error('오류: --title 필수'); process.exit(1); }
  const data = loadTracker();
  const id   = nextId(data.bugs, 'BUG');
  const now  = new Date().toISOString();

  data.bugs.push({
    id,
    title:        args.title,
    description:  args.desc || '',
    severity:     args.severity || 'medium',
    category:     args.category || 'general',
    status:       'open',
    detectedAt:   now,
    detectedBy:   args.by || 'unknown',
    relatedFiles: args.files ? args.files.split(',').map(f => f.trim()) : [],
    actions: [{
      timestamp:   now,
      actor:       args.by || 'unknown',
      type:        'report',
      description: args.desc || '버그 최초 보고'
    }],
    resolvedAt: null,
    resolvedBy: null
  });

  saveTracker(data);
  console.log(`✅ [${id}] 버그 등록: ${args.title}`);
  return id;
}

function cmdAction(args) {
  if (!args.id)   { console.error('오류: --id 필수');   process.exit(1); }
  if (!args.desc) { console.error('오류: --desc 필수'); process.exit(1); }
  const data = loadTracker();
  const bug  = data.bugs.find(b => b.id === args.id);
  if (!bug) { console.error(`오류: [${args.id}] 없음`); process.exit(1); }

  bug.actions.push({
    timestamp:   new Date().toISOString(),
    actor:       args.by || 'unknown',
    type:        args.type || 'note',
    description: args.desc
  });
  if (bug.status === 'open') bug.status = 'in_progress';

  saveTracker(data);
  console.log(`✅ [${args.id}] 조치 추가 (${bug.actions.length}번째)`);
}

function cmdResolve(args) {
  if (!args.id) { console.error('오류: --id 필수'); process.exit(1); }
  const data = loadTracker();
  const bug  = data.bugs.find(b => b.id === args.id);
  if (!bug) { console.error(`오류: [${args.id}] 없음`); process.exit(1); }

  const now = new Date().toISOString();
  if (args.desc) {
    bug.actions.push({ timestamp: now, actor: args.by || 'unknown', type: 'fix', description: args.desc });
  }
  bug.status     = 'resolved';
  bug.resolvedAt = now;
  bug.resolvedBy = args.by || 'unknown';

  saveTracker(data);
  console.log(`✅ [${args.id}] 해결 완료`);
}

function cmdList(args) {
  const data   = loadTracker();
  const filter = args.status || 'open';
  const bugs   = filter === 'all'
    ? data.bugs
    : data.bugs.filter(b =>
        b.status === filter ||
        (filter === 'open' && b.status === 'in_progress')
      );

  if (bugs.length === 0) {
    console.log(`[버그] ${filter} 상태: 없음`);
    return;
  }
  console.log(`\n📋 버그 목록 [${filter}] — ${bugs.length}건\n`);
  for (const b of bugs) {
    console.log(`${STATUS_ICON[b.status] || '?'} [${b.id}] ${SEV_ICON[b.severity] || ''} ${b.title}`);
    console.log(`   카테고리: ${b.category} | 발견: ${b.detectedBy} | ${ageText(b.detectedAt)} | 조치: ${b.actions.length}건`);
    if (b.relatedFiles.length) console.log(`   파일: ${b.relatedFiles.join(', ')}`);
    console.log();
  }
}

function cmdShow(args) {
  if (!args.id) { console.error('오류: --id 필수'); process.exit(1); }
  const data = loadTracker();
  const bug  = data.bugs.find(b => b.id === args.id);
  if (!bug) { console.error(`오류: [${args.id}] 없음`); process.exit(1); }

  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(`${STATUS_ICON[bug.status]} [${bug.id}]  ${bug.title}`);
  console.log(line);
  console.log(`심각도: ${bug.severity}  |  카테고리: ${bug.category}  |  상태: ${bug.status}`);
  console.log(`발견자: ${bug.detectedBy}  |  발견: ${shortTs(bug.detectedAt)}`);
  if (bug.resolvedAt) console.log(`해결자: ${bug.resolvedBy}  |  해결: ${shortTs(bug.resolvedAt)}`);
  if (bug.relatedFiles.length) console.log(`파일: ${bug.relatedFiles.join(', ')}`);
  if (bug.description) console.log(`\n${bug.description}`);

  console.log(`\n조치 이력 (${bug.actions.length}건):`);
  for (const a of bug.actions) {
    console.log(`  [${shortTs(a.timestamp)}] [${a.type}] ${a.actor}: ${a.description}`);
  }
  console.log(`${line}\n`);
}

function cmdMaintenance(args) {
  if (!args.title) { console.error('오류: --title 필수'); process.exit(1); }
  const data = loadTracker();
  const id   = nextId(data.maintenance, 'MAINT');

  data.maintenance.push({
    id,
    title:         args.title,
    type:          args.type || 'fix',
    description:   args.desc || '',
    timestamp:     new Date().toISOString(),
    appliedBy:     args.by || 'unknown',
    relatedBugIds: args.bugs  ? args.bugs.split(',').map(s => s.trim())  : [],
    files:         args.files ? args.files.split(',').map(f => f.trim()) : []
  });

  saveTracker(data);
  console.log(`✅ [${id}] 유지보수 기록: ${args.title}`);
}

function cmdMaintList(args) {
  const data  = loadTracker();
  const limit = parseInt(args.limit || '10', 10);
  const items = [...data.maintenance]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit);

  if (items.length === 0) { console.log('[유지보수] 기록 없음'); return; }

  console.log(`\n🔧 유지보수 기록 (최근 ${items.length}건)\n`);
  for (const m of items) {
    const bugs = m.relatedBugIds.length ? ` → [${m.relatedBugIds.join(', ')}]` : '';
    console.log(`[${m.id}] [${m.type}] ${shortTs(m.timestamp)}  ${m.title}${bugs}`);
    if (m.appliedBy || m.files.length) {
      console.log(`   적용: ${m.appliedBy}` + (m.files.length ? ` | ${m.files.join(', ')}` : ''));
    }
    if (m.description) console.log(`   ${m.description}`);
    console.log();
  }
}

// ─── 메인 ────────────────────────────────────────────────────────────

const args = parseArgs(process.argv);

if      (args.new)           cmdNew(args);
else if (args.action)        cmdAction(args);
else if (args.resolve)       cmdResolve(args);
else if (args.show)          cmdShow(args);
else if (args.maintenance)   cmdMaintenance(args);
else if (args['maint-list']) cmdMaintList(args);
else if (args.list)          cmdList(args);
else if (args.sync)          { syncHandoff(loadTracker()); console.log('✅ HANDOFF.md 갱신 완료'); }
else {
  console.log(`
bug-report.js — 스카 버그 추적 & 유지보수 기록 (HANDOFF.md 자동 연동)

  --new         --title "제목" [--desc "설명"] [--severity critical|high|medium|low]
                [--by ska|claude] [--category stability|logic|ux|data|reliability]
                [--files "src/a.js,src/b.js"]

  --action      --id BUG-001 --desc "조치 내용"
                [--type investigate|fix|workaround|verify|note] [--by ska|claude]

  --resolve     --id BUG-001 [--desc "해결 요약"] [--by claude]

  --list        [--status open|in_progress|resolved|all]

  --show        --id BUG-001

  --maintenance --title "제목" [--type config|fix|feature|refactor|deploy|hotfix]
                [--desc "설명"] [--by claude]
                [--bugs "BUG-001,BUG-002"] [--files "src/a.js,src/b.js"]

  --maint-list  [--limit 10]
`);
}
