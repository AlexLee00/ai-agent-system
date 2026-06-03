'use strict';

/**
 * auto-dev-watch.ts — docs/auto_dev/ 신규 문서 감시 및 auto-dev-pipeline 대기열 등록
 *
 * 매 실행 시 docs/auto_dev/ 아래 두 패턴을 스캔:
 *   - ALARM_INCIDENT_*.md (알람 디스패치 허브 incident)
 *   - CODEX_SKA_EXCEPTION_*.md (스카팀 자기복구 roundtable 결과)
 * 신규 문서 발견 시 처리 요청 후 docs/auto_dev/processed/로 이동한다.
 *
 * launchd StartInterval: 300 (5분)
 */

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const { postAlarm } = require('../../../packages/core/lib/hub-alarm-client');
const runtimePaths = require('../lib/runtime-paths.js');
const {
  listAutoDevManifestEntries,
  markAutoDevManifestState,
  syncAutoDevManifest,
} = require('../../../packages/core/lib/auto-dev-manifest.ts');

const ROOT = env.PROJECT_ROOT;
const AUTO_DEV_DIR = path.join(ROOT, 'docs', 'auto_dev');
const WORKSPACE = runtimePaths.workspaceDir();
const STATE_FILE = process.env.CLAUDE_AUTO_DEV_STATE_FILE ||
  path.join(WORKSPACE, 'claude-auto-dev-state.json');
function isEnabled(): boolean {
  const raw = String(process.env.CLAUDE_AUTO_DEV_WATCH_ENABLED || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

async function scanAndEnqueue(): Promise<{
  scanned: string[];
  enqueued: string[];
  skipped: string[];
}> {
  const result = { scanned: [] as string[], enqueued: [] as string[], skipped: [] as string[] };

  if (!fs.existsSync(AUTO_DEV_DIR)) {
    console.log('[auto-dev-watch] docs/auto_dev/ 디렉토리 없음 — 스킵');
    return result;
  }

  const manifestOptions = { autoDevStateFile: STATE_FILE };
  syncAutoDevManifest(AUTO_DEV_DIR, manifestOptions);
  const targets = listAutoDevManifestEntries(AUTO_DEV_DIR, ['inbox'], manifestOptions)
    .filter((relPath) => {
      const name = path.basename(relPath);
      return name.startsWith('ALARM_INCIDENT_') || name.startsWith('CODEX_SKA_EXCEPTION_');
    })
    .map((relPath) => path.basename(relPath));
  result.scanned = targets;

  for (const fileName of targets) {
    const srcPath = path.join(AUTO_DEV_DIR, fileName);

    try {
      // Notify hub alarm that auto-dev-pipeline should pick this up
      await postAlarm({
        team: 'claude',
        fromBot: 'auto-dev-watch',
        severity: 'info',
        title: `auto_dev 신규 문서 발견: ${fileName}`,
        message: `docs/auto_dev/${fileName} 파일이 감지되었습니다. auto-dev-pipeline 처리 대기 중.`,
        alarmType: 'work',
        visibility: 'internal',
        payload: { event_type: 'auto_dev_watch_enqueued', file_name: fileName, file_path: `docs/auto_dev/${fileName}` },
      });

      markAutoDevManifestState(AUTO_DEV_DIR, `docs/auto_dev/${fileName}`, 'claimed', {
        claimedAt: new Date().toISOString(),
        claimedBy: 'auto-dev-watch',
      });
      result.enqueued.push(fileName);
      console.log(`[auto-dev-watch] 처리 등록: ${fileName}`);
    } catch (err: any) {
      result.skipped.push(fileName);
      console.warn(`[auto-dev-watch] ${fileName} 처리 실패 (스킵):`, err?.message);
    }
  }

  return result;
}

async function main() {
  if (!isEnabled()) {
    console.log('[auto-dev-watch] CLAUDE_AUTO_DEV_WATCH_ENABLED 비활성화 — 종료');
    process.exit(0);
  }

  console.log('[auto-dev-watch] 스캔 시작...');
  try {
    const result = await scanAndEnqueue();
    console.log(`[auto-dev-watch] 완료: 스캔 ${result.scanned.length}개, 등록 ${result.enqueued.length}개, 스킵 ${result.skipped.length}개`);
  } catch (err: any) {
    console.error('[auto-dev-watch] 오류:', err?.message);
    process.exit(1);
  }
}

main();
