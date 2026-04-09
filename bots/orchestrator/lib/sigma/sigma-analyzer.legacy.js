'use strict';

const { collectTeamMetric } = require('./sigma-feedback');

function inferFeedbackType(analystName) {
  if (analystName === 'hawk') return 'risk_review';
  if (analystName === 'dove') return 'growth_expand';
  if (analystName === 'owl') return 'trend_watch';
  if (analystName === 'optimizer') return 'workflow_tuning';
  if (analystName === 'librarian') return 'knowledge_capture';
  if (analystName === 'forecaster') return 'forecast_adjust';
  return 'general_review';
}

function formatMetricLine(team, metric) {
  if (!metric || typeof metric !== 'object') return `- ${team}: 메트릭 없음`;
  if (metric.metric_type === 'content_ops') {
    return `- ${team}: 최근 7일 발행 ${metric.published_7d}건, 준비 ${metric.ready_count}건`;
  }
  if (metric.metric_type === 'trading_ops') {
    return `- ${team}: 최근 7일 거래 ${metric.trades_7d}건, 거래액 $${metric.traded_usdt_7d.toFixed(2)}, live 포지션 ${metric.live_positions}건`;
  }
  if (metric.metric_type === 'research_ops') {
    return `- ${team}: 연구 수집 ${metric.total_collected}건, 고적합 ${metric.high_relevance}건, 소요 ${metric.duration_sec}초`;
  }
  if (metric.metric_type === 'agent_health') {
    return `- ${team}: 활성 에이전트 ${metric.active_agents}명, 평균 점수 ${metric.avg_score}, 저성과 ${metric.low_score_agents}명`;
  }
  if (metric.error) {
    return `- ${team}: 메트릭 수집 실패 (${metric.error})`;
  }
  return `- ${team}: ${JSON.stringify(metric)}`;
}

function buildRecommendation(team, metric, primaryAnalyst, specialists = []) {
  const extra = specialists.length > 0 ? ` / 보조: ${specialists.join(', ')}` : '';
  if (primaryAnalyst === 'hawk') {
    return `리스크 관점에서 ${team}의 병목/실패 패턴을 우선 점검하세요.${extra}`;
  }
  if (primaryAnalyst === 'dove') {
    return `성공 패턴이 보이는 ${team}의 강점을 확대하고 재사용 가능한 운영 규칙을 추출하세요.${extra}`;
  }
  if (primaryAnalyst === 'owl') {
    return `${team}의 주간 추세를 기준으로 구조적 변화 여부를 점검하세요.${extra}`;
  }
  return `${team}의 핵심 지표를 일일 기준으로 추적하고 다음 실행에 반영할 개선점을 정리하세요.${extra}`;
}

async function analyzeFormation(formation) {
  const targetTeams = Array.isArray(formation?.targetTeams) ? formation.targetTeams : [];
  const analysts = Array.isArray(formation?.analysts) ? formation.analysts : [];
  const primaryAnalyst = analysts.find((name) => ['hawk', 'dove', 'owl'].includes(name)) || 'pivot';
  const specialists = analysts.filter((name) => ['optimizer', 'librarian', 'forecaster'].includes(name));
  const metricsByTeam = {};
  const feedbacks = [];
  const lines = [
    `📈 시그마 일일 편성 (${formation?.date || 'unknown'})`,
    `- 대상 팀: ${targetTeams.join(', ') || '없음'}`,
    `- 편성: ${analysts.join(', ') || '없음'}`,
    `- 기준: ${formation?.formationReason || '일일 로테이션'}`,
    '',
    '팀별 관찰:',
  ];

  for (const team of targetTeams) {
    const metric = await collectTeamMetric(team);
    metricsByTeam[team] = metric;
    lines.push(formatMetricLine(team, metric));
    feedbacks.push({
      targetTeam: team,
      feedbackType: inferFeedbackType(primaryAnalyst),
      content: buildRecommendation(team, metric, primaryAnalyst, specialists),
      analystUsed: primaryAnalyst,
      beforeMetric: metric,
    });
  }

  if (specialists.includes('optimizer') && (formation?.events?.unhealthyServices || []).length > 0) {
    feedbacks.push({
      targetTeam: 'claude',
      feedbackType: 'workflow_tuning',
      content: `launchd 비정상 서비스 ${formation.events.unhealthyServices.length}건을 기준으로 자동 복구/재기동 정책을 점검하세요.`,
      analystUsed: 'optimizer',
      beforeMetric: { unhealthy_services: formation.events.unhealthyServices.length },
    });
  }

  if (specialists.includes('librarian') && Number(formation?.events?.newExperiences || 0) > 10) {
    feedbacks.push({
      targetTeam: 'darwin',
      feedbackType: 'knowledge_capture',
      content: `누적 경험 ${formation.events.newExperiences}건을 기반으로 Standing Orders 승격 후보를 정리하세요.`,
      analystUsed: 'librarian',
      beforeMetric: { new_experiences: formation.events.newExperiences },
    });
  }

  if (specialists.includes('forecaster') && targetTeams.includes('luna')) {
    feedbacks.push({
      targetTeam: 'luna',
      feedbackType: 'forecast_adjust',
      content: '최근 거래 흐름을 기반으로 다음 24시간 변동성/포지션 리스크 예측을 추가 점검하세요.',
      analystUsed: 'forecaster',
      beforeMetric: metricsByTeam.luna || {},
    });
  }

  lines.push('', '제안된 피드백:');
  feedbacks.forEach((item) => {
    lines.push(`- [${item.targetTeam}] ${item.feedbackType}: ${item.content}`);
  });

  return {
    report: lines.join('\n'),
    metricsByTeam,
    feedbacks,
    insightCount: targetTeams.length,
  };
}

module.exports = {
  analyzeFormation,
};
