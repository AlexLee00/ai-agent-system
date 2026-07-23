// @ts-nocheck
'use strict';

function compactTitle(value = '', max = 72) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'none';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function buildDailyReportContract({ traceId = '', results = [], operations = {} } = {}) {
  const successCount = results.filter((item) => !item?.error && !item?.skipped).length;
  const failureCount = results.filter((item) => item?.error).length;
  const skippedCount = results.filter((item) => item?.skipped).length;
  const nextExecution = [];
  const appliedLearning = [];
  const risks = [];

  if (operations.opsTitlePatternSummary) appliedLearning.push(operations.opsTitlePatternSummary);
  if (operations.opsAlignmentSummary) appliedLearning.push(operations.opsAlignmentSummary);
  if (operations.opsAutonomyLaneSummary) appliedLearning.push(operations.opsAutonomyLaneSummary);
  if (operations.evalLatestSummary) appliedLearning.push(`최근 eval learning: ${operations.evalLatestSummary}`);
  if (operations.evalRecurringSummary) appliedLearning.push(`반복 eval code: ${operations.evalRecurringSummary}`);

  if (operations.nextGeneralCategory && operations.nextGeneralCategory !== 'none') {
    nextExecution.push(`다음 일반 카테고리: ${operations.nextGeneralCategory}`);
  }
  if (operations.nextGeneralPattern && operations.nextGeneralPattern !== 'none') {
    nextExecution.push(`다음 제목 패턴: ${operations.nextGeneralPattern}`);
  }
  if (operations.nextGeneralTitle && operations.nextGeneralTitle !== 'none') {
    nextExecution.push(`다음 제목 후보: ${compactTitle(operations.nextGeneralTitle)}`);
  }
  if (operations.predictedAdoption && operations.predictedAdoption !== 'warming_up') {
    nextExecution.push(`전략 정렬 예상: ${operations.predictedAdoption}`);
  }
  if (operations.dailyMixPrimaryCategory || operations.dailyMixTitlePattern) {
    nextExecution.push(`daily mix: ${operations.dailyMixPrimaryCategory || 'none'} / ${operations.dailyMixTitlePattern || 'none'} / ${operations.dailyMixRotationMode || 'balanced'}${operations.dailyMixStabilityMode ? ' / stability' : ''}`);
  }

  if (failureCount > 0) {
    risks.push(`실패 ${failureCount}건이 있어 해당 stage 재확인 필요`);
  }
  if (skippedCount > 0) {
    risks.push(`스킵 ${skippedCount}건은 조건/큐 상태 점검 필요`);
  }
  if (operations.suppressedPattern && operations.suppressedPattern !== 'none') {
    risks.push(`억제 패턴 ${operations.suppressedPattern} 재사용 주의`);
  }

  return {
    title: '블로팀 일간 자율운영 리포트',
    sections: [
      {
        title: '상태',
        lines: [
          `trace: ${String(traceId || '').slice(0, 8) || 'unknown'}`,
          `결과: 성공 ${successCount} / 실패 ${failureCount} / 스킵 ${skippedCount}`,
          operations.briefLine || 'Naver 콘텐츠 운영 상태 없음',
        ].filter(Boolean),
      },
      {
        title: '판단 근거',
        lines: [
          `scope: ${operations.signalLabel || 'Naver 포스팅'}`,
          `plan: ${operations.preferredCategory || 'none'}/${operations.preferredPattern || 'none'}`,
          `suppress: ${operations.suppressedPattern || 'none'}`,
        ],
      },
      {
        title: '이번에 반영된 학습',
        lines: appliedLearning.length ? appliedLearning : ['최근 콘텐츠 학습 신호 없음'],
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
