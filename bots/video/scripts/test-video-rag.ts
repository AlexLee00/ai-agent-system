// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');

const rag = require('../../../packages/core/lib/rag-safe');
const { loadConfig } = require('../src/index');
const { loadEDL } = require('../lib/edl-builder');
const {
  storeEditResult,
  storeEditFeedback,
  searchSimilarEdits,
  searchEditPatterns,
  enhanceCriticWithRAG,
  enhanceEDLWithRAG,
  estimateWithRAG,
} = require('../lib/video-rag');

const TEMP_DIR = path.join(__dirname, '..', 'temp');
const ANALYSIS_PATH = path.join(TEMP_DIR, 'analysis.json');
const CRITIC_REPORT_PATH = path.join(TEMP_DIR, 'critic_report.json');
const EDL_PATH = path.join(TEMP_DIR, 'edit_decision_list.json');
const RESULT_PATH = path.join(TEMP_DIR, 'video_rag_test_result.json');

async function main() {
  const config = loadConfig();
  const analysis = JSON.parse(fs.readFileSync(ANALYSIS_PATH, 'utf8'));
  const criticReport = JSON.parse(fs.readFileSync(CRITIC_REPORT_PATH, 'utf8'));
  const edl = loadEDL(EDL_PATH);

  await rag.initSchema();
  console.log('[test] rag.initSchema: ✅ rag_video 포함 초기화 확인');

  const storedEdit = await storeEditResult({
    title: 'FlutterFlow DB 생성',
    duration: analysis.duration,
    subtitleCount: criticReport.analysis_summary?.subtitle_entries || 67,
    qualityScore: criticReport.score,
    qualityPass: criticReport.pass,
    cutCount: (edl.edits || []).filter((item) => item.type === 'cut').length,
    transitionCount: (edl.edits || []).filter((item) => item.type === 'transition').length,
    silenceCount: analysis.silences?.length || 0,
    freezeCount: analysis.freezes?.length || 0,
    subtitleIssuesCount: criticReport.analysis_summary?.subtitle_issues_count || 0,
    audioIssuesCount: criticReport.issues?.filter((item) => String(item.type || '').startsWith('audio_')).length || 0,
    subtitleIssueTypes: criticReport.issues?.filter((item) => String(item.type || '').startsWith('subtitle_')).map((item) => item.type) || [],
    audioIssueTypes: criticReport.issues?.filter((item) => String(item.type || '').startsWith('audio_')).map((item) => item.type) || [],
    videoIssueTypes: criticReport.issues?.filter((item) => ['silent_gap', 'freeze_frame', 'scene_change', 'excessive_scenes', 'low_efficiency'].includes(item.type)).map((item) => item.type) || [],
    edlEditTypes: (edl.edits || []).map((item) => item.type),
    totalMs: 180000,
    totalCostUsd: 0.001,
    videoWidth: analysis.metadata?.width,
    videoHeight: analysis.metadata?.height,
    videoFps: analysis.metadata?.fps,
  }, config);
  console.log('[test] storeEditResult:', storedEdit);

  const storedFeedback = await storeEditFeedback(999999, {
    confirmed: false,
    rejectReason: '02:30 여기 잘라줘',
    text: '02:30 여기 잘라줘',
  }, config);
  console.log('[test] storeEditFeedback:', storedFeedback);

  const similar = await searchSimilarEdits('FlutterFlow 강의 73분 자막 67개', {
    limit: 5,
    threshold: 0.2,
  });
  console.log(`[test] searchSimilarEdits: ${similar.length}건`);

  const patterns = await searchEditPatterns(analysis, config);
  console.log('[test] searchEditPatterns:', {
    patterns: patterns.patterns.length,
    sample_count: patterns.suggestions.sample_count,
    avg_quality_score: patterns.suggestions.avg_quality_score,
  });

  const estimate = await estimateWithRAG(1, 146, Math.round((analysis.duration || 0) / 60));
  console.log('[test] estimateWithRAG:', estimate);

  const enhancedCritic = await enhanceCriticWithRAG(criticReport, config);
  console.log('[test] enhanceCriticWithRAG:', enhancedCritic.rag_insights || null);

  const enhancedEDL = await enhanceEDLWithRAG(edl, analysis, config);
  console.log('[test] enhanceEDLWithRAG:', enhancedEDL.rag_source || null);

  const payload = {
    storedEdit,
    storedFeedback,
    similarCount: similar.length,
    patterns: {
      count: patterns.patterns.length,
      suggestions: patterns.suggestions,
    },
    estimate,
    criticInsights: enhancedCritic.rag_insights || null,
    edlRagSource: enhancedEDL.rag_source || null,
  };
  fs.writeFileSync(RESULT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[test] 결과 저장: ${RESULT_PATH}`);
  console.log('[test] video-rag 테스트 완료!');
}

main().catch((error) => {
  console.error('[test] video-rag 실패:', error.message);
  process.exit(1);
});
