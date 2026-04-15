// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const yaml = require('js-yaml');
const { createAgentMemory } = require('../../../packages/core/lib/agent-memory');
const { buildVideoCliInsight } = require('../lib/cli-insight.js');

const configPath = path.join(__dirname, '..', 'config', 'video-config.yaml');
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

const capcutHost = config.capcut_api?.host || 'http://localhost:9001';
const capcutRepoDir = config.capcut_api?.mcp_cwd;
const capcutDesktopDraftDir = config.paths?.capcut_drafts;
const capcutReadinessMemory = createAgentMemory({ agentId: 'video.capcut-readiness', team: 'video' });

function buildCapcutReadinessMemoryQuery(kind, extras = []) {
  return [
    'video capcut readiness',
    kind,
    ...extras,
  ].filter(Boolean).join(' ');
}

function execFileAsync(cmd, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function getJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON 응답 파싱 실패: ${url} -> ${text.slice(0, 200)}`);
  }
  return { ok: response.ok, status: response.status, data };
}

async function isCapCutDesktopRunning() {
  const { stdout } = await execFileAsync('ps', ['aux']);
  return /\/Applications\/CapCut\.app\/Contents\/MacOS\/CapCut/.test(stdout);
}

function listDraftDirs(baseDir) {
  if (!baseDir || !fs.existsSync(baseDir)) return [];
  return fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^dfd_cat_/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function pickNewDraft(before, after) {
  const beforeSet = new Set(before);
  const created = after.filter((name) => !beforeSet.has(name));
  return created[0] || null;
}

function buildCapcutReadinessFallback({
  desktopRunning,
  createdRepoDraft,
  createdDesktopDraft,
} = {}) {
  if (!desktopRunning) {
    return 'CapCut Desktop가 꺼져 있어 readiness보다 먼저 앱 실행 상태를 확인하는 것이 좋습니다.';
  }
  if (!createdDesktopDraft && createdRepoDraft) {
    return 'CapCut draft는 생성됐지만 Desktop 프로젝트 폴더로 바로 떨어지지 않아 repo→Desktop 이동 경로를 먼저 확인하는 편이 좋습니다.';
  }
  if (!createdRepoDraft && !createdDesktopDraft) {
    return 'CapCut readiness 점검에서 새 draft가 확인되지 않아 API 저장 경로와 draft 생성 응답을 먼저 확인하는 것이 좋습니다.';
  }
  return 'CapCut readiness는 비교적 안정적이며 현재 draft 생성과 저장 흐름이 정상으로 보입니다.';
}

async function main() {
  console.log('[check] CapCut readiness 시작');
  console.log(`[check] host: ${capcutHost}`);
  console.log(`[check] repo draft dir: ${capcutRepoDir}`);
  console.log(`[check] desktop draft dir: ${capcutDesktopDraftDir}`);

  if (!capcutRepoDir || !fs.existsSync(capcutRepoDir)) {
    throw new Error(`CapCutAPI 설치 경로가 없습니다: ${capcutRepoDir}`);
  }
  if (!capcutDesktopDraftDir || !fs.existsSync(capcutDesktopDraftDir)) {
    throw new Error(`CapCut Desktop 프로젝트 경로가 없습니다: ${capcutDesktopDraftDir}`);
  }

  const desktopRunning = await isCapCutDesktopRunning();
  console.log(`[check] CapCut Desktop 실행: ${desktopRunning ? '✅' : '❌'}`);

  const health = await getJson(`${capcutHost}/get_font_types`);
  if (!health.ok || !health.data?.success) {
    throw new Error(`CapCutAPI 응답 이상: HTTP ${health.status}`);
  }
  console.log(`[check] CapCutAPI 응답: ✅ (${Array.isArray(health.data.output) ? health.data.output.length : 0} fonts)`);

  const beforeRepoDrafts = listDraftDirs(capcutRepoDir);
  const beforeDesktopDrafts = listDraftDirs(capcutDesktopDraftDir);

  const create = await getJson(`${capcutHost}/create_draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'codex_capcut_readiness',
      width: config.ffmpeg?.render_width || 2560,
      height: config.ffmpeg?.render_height || 1440,
    }),
  });
  if (!create.ok || !create.data?.success || !create.data?.output?.draft_id) {
    throw new Error(`create_draft 실패: ${JSON.stringify(create.data)}`);
  }

  const draftId = create.data.output.draft_id;
  console.log(`[check] create_draft: ✅ (${draftId})`);

  const save = await getJson(`${capcutHost}/save_draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft_id: draftId }),
  });
  if (!save.ok || !save.data?.success) {
    throw new Error(`save_draft 실패: ${JSON.stringify(save.data)}`);
  }
  console.log('[check] save_draft: ✅');

  const afterRepoDrafts = listDraftDirs(capcutRepoDir);
  const afterDesktopDrafts = listDraftDirs(capcutDesktopDraftDir);

  const createdRepoDraft = pickNewDraft(beforeRepoDrafts, afterRepoDrafts);
  const createdDesktopDraft = pickNewDraft(beforeDesktopDrafts, afterDesktopDrafts);

  if (createdRepoDraft) {
    console.log(`[check] repo draft 생성: ✅ ${path.join(capcutRepoDir, createdRepoDraft)}`);
  } else {
    console.log('[check] repo draft 생성: ⚠️ 새 dfd_* 폴더를 찾지 못함');
  }

  if (createdDesktopDraft) {
    console.log(`[check] desktop draft 생성: ✅ ${path.join(capcutDesktopDraftDir, createdDesktopDraft)}`);
  } else {
    console.log('[check] desktop draft 생성: ⚠️ 새 dfd_* 폴더를 찾지 못함');
  }

  if (!createdDesktopDraft && createdRepoDraft) {
    console.log('[check] 해석: CapCutAPI는 현재 Draft를 Desktop 프로젝트 폴더가 아니라 repo 내부에 저장합니다.');
    console.log('[check] 다음 단계: 과제 5에서는 save_draft 후 repo 내부 dfd_*를 찾아 copyToCapCut()으로 이동해야 합니다.');
  }

  const kind = createdDesktopDraft ? 'healthy' : 'issue';
  const memoryQuery = buildCapcutReadinessMemoryQuery(kind, [
    desktopRunning ? 'desktop-running' : 'desktop-stopped',
    createdRepoDraft ? 'repo-draft-created' : 'repo-draft-missing',
    createdDesktopDraft ? 'desktop-draft-created' : 'desktop-draft-missing',
  ]);
  const episodicHint = await capcutReadinessMemory.recallCountHint(memoryQuery, {
    type: 'episodic',
    limit: 2,
    threshold: 0.33,
    title: '최근 유사 readiness',
    separator: 'pipe',
    metadataKey: 'kind',
    labels: {
      healthy: '정상',
      issue: '이슈',
    },
    order: ['issue', 'healthy'],
  }).catch(() => '');
  const semanticHint = await capcutReadinessMemory.recallHint(`${memoryQuery} consolidated capcut readiness pattern`, {
    type: 'semantic',
    limit: 2,
    threshold: 0.28,
    title: '최근 통합 패턴',
    separator: 'newline',
  }).catch(() => '');
  const summary = [
    'CapCut readiness 점검',
    `desktopRunning: ${desktopRunning}`,
    `repoDraftCreated: ${Boolean(createdRepoDraft)}`,
    `desktopDraftCreated: ${Boolean(createdDesktopDraft)}`,
    createdRepoDraft ? `repoDraft: ${createdRepoDraft}` : null,
    createdDesktopDraft ? `desktopDraft: ${createdDesktopDraft}` : null,
  ].filter(Boolean).join('\n');
  const aiSummary = await buildVideoCliInsight({
    bot: 'check-capcut-readiness',
    requestType: 'capcut-readiness',
    title: '비디오 CapCut readiness 점검 요약',
    data: {
      desktopRunning,
      repoDraftCreated: Boolean(createdRepoDraft),
      desktopDraftCreated: Boolean(createdDesktopDraft),
      createdRepoDraft,
      createdDesktopDraft,
      host: capcutHost,
    },
    fallback: buildCapcutReadinessFallback({
      desktopRunning,
      createdRepoDraft,
      createdDesktopDraft,
    }),
  });

  if (episodicHint) console.log(episodicHint.trimStart());
  if (semanticHint) console.log(semanticHint.trimStart());
  console.log(`🔍 AI: ${aiSummary}`);

  await capcutReadinessMemory.remember(summary, 'episodic', {
    importance: kind === 'issue' ? 0.76 : 0.6,
    expiresIn: 1000 * 60 * 60 * 24 * 30,
    metadata: {
      kind,
      desktopRunning,
      repoDraftCreated: Boolean(createdRepoDraft),
      desktopDraftCreated: Boolean(createdDesktopDraft),
    },
  }).catch(() => {});
  await capcutReadinessMemory.consolidate({
    olderThanDays: 14,
    limit: 10,
  }).catch(() => {});

  console.log('[check] CapCut readiness 완료');
}

main().catch((error) => {
  const message = error?.message || String(error);
  buildVideoCliInsight({
    bot: 'check-capcut-readiness',
    requestType: 'capcut-readiness',
    title: '비디오 CapCut readiness 실패 요약',
    data: {
      error: message,
      host: capcutHost,
    },
    fallback: 'CapCut readiness 점검이 실패해 API 응답과 Desktop 프로젝트 경로를 먼저 확인하는 것이 좋습니다.',
  }).then((aiSummary) => {
    if (aiSummary) console.error(`🔍 AI: ${aiSummary}`);
  }).catch(() => {});
  capcutReadinessMemory.remember([
    'CapCut readiness 점검 실패',
    `reason: ${message}`,
  ].join('\n'), 'episodic', {
    importance: 0.84,
    expiresIn: 1000 * 60 * 60 * 24 * 30,
    metadata: {
      kind: 'issue',
      failed: true,
      reason: message,
    },
  }).catch(() => {});
  capcutReadinessMemory.consolidate({
    olderThanDays: 14,
    limit: 10,
  }).catch(() => {});
  console.error(`[check] 실패: ${error.message}`);
  process.exit(1);
});
