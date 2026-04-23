'use strict';

function compactTitle(value = '', max = 72) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'none';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function buildDailyReportContract({ traceId = '', results = [], marketing = {} } = {}) {
  const successCount = results.filter((item) => !item?.error && !item?.skipped).length;
  const failureCount = results.filter((item) => item?.error).length;
  const skippedCount = results.filter((item) => item?.skipped).length;
  const nextExecution = [];
  const appliedLearning = [];
  const risks = [];

  if (marketing.opsTitlePatternSummary) appliedLearning.push(marketing.opsTitlePatternSummary);
  if (marketing.opsAlignmentSummary) appliedLearning.push(marketing.opsAlignmentSummary);
  if (marketing.opsAutonomyLaneSummary) appliedLearning.push(marketing.opsAutonomyLaneSummary);
  if (marketing.experimentWinnerSummary) appliedLearning.push(marketing.experimentWinnerSummary);
  if (marketing.experimentWeakLaneSummary) appliedLearning.push(marketing.experimentWeakLaneSummary);
  if (marketing.evalLatestSummary) appliedLearning.push(`최근 eval learning: ${marketing.evalLatestSummary}`);
  if (marketing.evalRecurringSummary) appliedLearning.push(`반복 eval code: ${marketing.evalRecurringSummary}`);

  if (marketing.nextGeneralCategory && marketing.nextGeneralCategory !== 'none') {
    nextExecution.push(`다음 일반 카테고리: ${marketing.nextGeneralCategory}`);
  }
  if (marketing.nextGeneralPattern && marketing.nextGeneralPattern !== 'none') {
    nextExecution.push(`다음 제목 패턴: ${marketing.nextGeneralPattern}`);
  }
  if (marketing.nextGeneralTitle && marketing.nextGeneralTitle !== 'none') {
    nextExecution.push(`다음 제목 후보: ${compactTitle(marketing.nextGeneralTitle)}`);
  }
  if (marketing.predictedAdoption && marketing.predictedAdoption !== 'warming_up') {
    nextExecution.push(`전략 정렬 예상: ${marketing.predictedAdoption}`);
  }
  if (marketing.dailyMixPrimaryCategory || marketing.dailyMixTitlePattern) {
    nextExecution.push(`daily mix: ${marketing.dailyMixPrimaryCategory || 'none'} / ${marketing.dailyMixTitlePattern || 'none'} / ${marketing.dailyMixRotationMode || 'balanced'}${marketing.dailyMixStabilityMode ? ' / stability' : ''}`);
  }

  if (failureCount > 0) {
    risks.push(`실패 ${failureCount}건이 있어 해당 stage 재확인 필요`);
  }
  if (skippedCount > 0) {
    risks.push(`스킵 ${skippedCount}건은 조건/큐 상태 점검 필요`);
  }
  if (marketing.suppressedPattern && marketing.suppressedPattern !== 'none') {
    risks.push(`억제 패턴 ${marketing.suppressedPattern} 재사용 주의`);
  }
  if (marketing.experimentWeakLaneSummary) {
    risks.push(compactTitle(marketing.experimentWeakLaneSummary, 120));
  }

  return {
    title: '블로팀 일간 자율운영 리포트',
    sections: [
      {
        title: '상태',
        lines: [
          `trace: ${String(traceId || '').slice(0, 8) || 'unknown'}`,
          `결과: 성공 ${successCount} / 실패 ${failureCount} / 스킵 ${skippedCount}`,
          marketing.briefLine || '마케팅/전략 상태 없음',
        ].filter(Boolean),
      },
      {
        title: '판단 근거',
        lines: [
          `signal: ${marketing.signalLabel || '특이 신호 없음'}`,
          `impact: ${Number(marketing.revenueImpactPct || 0) * 100}%`,
          `plan: ${marketing.preferredCategory || 'none'}/${marketing.preferredPattern || 'none'}`,
          `suppress: ${marketing.suppressedPattern || 'none'}`,
        ],
      },
      {
        title: '이번에 반영된 학습',
        lines: appliedLearning.length ? appliedLearning : ['최근 운영/실험 학습 신호 없음'],
      },
      {
        title: '다음 실행',
        lines: nextExecution.length ? nextExecution : ['다음 실행 후보 없음'],
      },
      {
        title: '리스크',
        lines: risks.length ? risks : ['즉시 위험 신호 없음'],
      },
    ],
  };
}

module.exports = {
  buildDailyReportContract,
};
