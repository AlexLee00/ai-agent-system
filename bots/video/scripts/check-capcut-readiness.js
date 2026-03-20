const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const yaml = require('js-yaml');

const configPath = path.join(__dirname, '..', 'config', 'video-config.yaml');
const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

const capcutHost = config.capcut_api?.host || 'http://localhost:9001';
const capcutRepoDir = config.capcut_api?.mcp_cwd;
const capcutDesktopDraftDir = config.paths?.capcut_drafts;

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

  console.log('[check] CapCut readiness 완료');
}

main().catch((error) => {
  console.error(`[check] 실패: ${error.message}`);
  process.exit(1);
});
