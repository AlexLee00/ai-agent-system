'use strict';

const fs = require('fs');
const path = require('path');

const { loadConfig } = require('../src/index');
const { runCritic, saveCriticReport } = require('../lib/critic-agent');

const VIDEO_PATH = path.join(__dirname, '..', 'temp', 'synced.mp4');
const SUBTITLE_PATH = path.join(__dirname, '..', 'temp', 'subtitle_corrected.srt');
const ANALYSIS_PATH = path.join(__dirname, '..', 'temp', 'analysis.json');
const REPORT_PATH = path.join(__dirname, '..', 'temp', 'critic_report.json');

function printIssues(label, issues, limit = 3) {
  console.log(`[test] ${label}: ${issues.length}건`);
  issues.slice(0, limit).forEach((issue, index) => {
    console.log(`  ${index + 1}. ${JSON.stringify(issue)}`);
  });
}

async function main() {
  const config = loadConfig();
  const report = await runCritic(VIDEO_PATH, SUBTITLE_PATH, ANALYSIS_PATH, config);
  saveCriticReport(report, REPORT_PATH);

  console.log(`[test] 전체 점수: ${report.score} (${report.pass ? 'PASS' : 'FAIL'})`);
  console.log(`[test] 자막 점수: ${report.scores.subtitle_accuracy}`);
  printIssues('자막 이슈', report.issues.filter((issue) => String(issue.type || '').startsWith('subtitle_')));
  console.log(`[test] 오디오 점수: ${report.scores.audio_quality} / LUFS=${report.analysis_summary.audio_lufs} / Peak=${report.analysis_summary.audio_peak}`);
  printIssues('오디오 이슈', report.issues.filter((issue) => String(issue.type || '').startsWith('audio_')));
  console.log(
    `[test] 영상 구조 점수: ${report.scores.video_structure} / 무음=${report.analysis_summary.silences_count}, 정지=${report.analysis_summary.freezes_count}, 씬=${report.analysis_summary.scenes_count}`
  );
  printIssues('영상 구조 이슈', report.issues.filter((issue) => ['silent_gap', 'freeze_frame', 'scene_change', 'excessive_scenes', 'low_efficiency'].includes(issue.type)));
  console.log(`[test] LLM 비용: $${Number(report.llm_cost_usd || 0).toFixed(6)}`);
  console.log(`[test] critic_report 저장: ${REPORT_PATH}`);

  if (!fs.existsSync(REPORT_PATH)) {
    throw new Error('critic_report.json 파일이 생성되지 않았습니다.');
  }

  console.log('[test] 과제 10 Critic Agent 테스트 완료!');
}

main().catch((error) => {
  console.error('[test] Critic Agent 실패:', error.message);
  process.exit(1);
});
