// @ts-nocheck

const DEPLOYMENT_LABELS = Object.freeze({
  halt: '신규 진입 중단(halt)',
  reduced: '축소 운용(reduced)',
  full: '정상 운용(full)',
  unknown: '운용 상태 미정',
});

const REGIME_LABELS = Object.freeze({
  bull: '상승 시장 분위기(bull)',
  bear: '하락 시장 분위기(bear)',
  sideways: '수평 시장 분위기(sideways)',
  volatile: '변동성 큰 시장 분위기(volatile)',
});

const COMPONENT_LABELS = Object.freeze({
  'regime-engine-hmm': '레짐 엔진(시장 분위기 판별기, C2)',
  'market-deployment-gate': '시장 배치 게이트(시장 건강 점수, C1)',
  mapek: 'MAPEK 운영 루프(C15)',
  'meeting-room-orchestrator': '회의실 오케스트레이터(C15)',
  'backtest-nextbar-execution': 'Next-bar 백테스트 실행 검증(C15)',
  'circuit-locks': '손실 방지 잠금(서킷)',
});

const TERM_REPLACEMENTS = Object.freeze([
  [/\bG0\s*게이트\b/g, '시장 건강 점수(G0 게이트)'],
  [/\bC1\s*시장\s*배치\s*게이트\b/g, '시장 배치 게이트(시장 건강 점수, C1)'],
  [/\bC2\s*레짐\b/g, '시장 분위기(C2 레짐)'],
  [/C15\s*검토/g, '부품 승격 검토(C15)'],
  [/C15\s*레짐\s*엔진\s*HMM/g, '시장 분위기 판별기(HMM, C2)'],
  [/C15\s*MAPEK/g, 'MAPEK 운영 루프(C15)'],
  [/(?<!\()C15(?!\))/g, '부품 승격 검토(C15)'],
  [/\bBrier\b/g, '예측 적중 품질(Brier)'],
  [/\bOOS\b/g, '검증 구간 성과(OOS)'],
  [/(?<!C2 )레짐/g, '시장 분위기(레짐)'],
  [/(?<!\()서킷/g, '손실 방지 잠금(서킷)'],
  [/(?<!방지 )잠금/g, '손실 방지 잠금'],
  [/(?<!\()전략\s*신호/g, '매매 후보 신호(전략 신호)'],
  [/전략신호/g, '매매 후보 신호(전략 신호)'],
  [/(?<!\()표본/g, '누적 사례(표본)'],
]);

function text(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

export function plainDeploymentStatus(value) {
  const key = text(value, 'unknown').toLowerCase();
  return DEPLOYMENT_LABELS[key] || text(value, '운용 상태 미정');
}

export function plainRegimeLabel(value) {
  const key = text(value).toLowerCase();
  return REGIME_LABELS[key] || text(value, '시장 분위기 미정');
}

export function plainComponentLabel(value) {
  const key = text(value);
  return COMPONENT_LABELS[key] || key || '검토 대상';
}

export function applyMeetingGlossary(value) {
  let next = text(value);
  if (!next) return next;
  next = next
    .replace(/(?<!\()\bhalt\b/g, plainDeploymentStatus('halt'))
    .replace(/(?<!\()\breduced\b/g, plainDeploymentStatus('reduced'))
    .replace(/(?<!\()\bfull\b/g, plainDeploymentStatus('full'))
    .replace(/(?<!\()\bbull\b/g, plainRegimeLabel('bull'))
    .replace(/(?<!\()\bbear\b/g, plainRegimeLabel('bear'))
    .replace(/(?<!\()\bsideways\b/g, plainRegimeLabel('sideways'))
    .replace(/(?<!\()\bvolatile\b/g, plainRegimeLabel('volatile'));
  for (const [pattern, replacement] of TERM_REPLACEMENTS) {
    next = next.replace(pattern, replacement);
  }
  for (const [key, label] of Object.entries(COMPONENT_LABELS)) {
    next = next.replace(new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), label);
  }
  return next;
}

function agendaQuestion(agendaKey, title) {
  const key = text(agendaKey);
  const label = text(title, plainComponentLabel(key.replace(/^decision:/, '')));
  if (key.startsWith('market:')) return `${label}을 오늘도 관찰만 할까요, 별도 확인이 필요할까요?`;
  if (key === 'alerts:circuit-locks') return '손실 방지 잠금 상태를 그대로 관찰할까요, 마스터 확인이 필요할까요?';
  if (key.startsWith('decision:')) return `${plainComponentLabel(key.replace(/^decision:/, ''))}을 다음 단계 후보로 둘까요, 더 지켜볼까요?`;
  return `${label} 안건을 확정 기록할까요, 보류하고 더 지켜볼까요?`;
}

export function buildDecisionPlainFields(input = {}) {
  const evidence = input.evidence && typeof input.evidence === 'object' ? input.evidence : {};
  const existing = evidence.ux && typeof evidence.ux === 'object' ? evidence.ux : {};
  const agendaKey = input.agendaKey || input.agenda_key || input.agenda?.key || evidence.agendaKey || '';
  const title = input.title || input.agenda?.title || evidence.title || input.decision || '회의 결정';
  const agendaKind = input.agendaKind || input.agenda?.kind || evidence.agendaKind || '';
  const safeTitle = applyMeetingGlossary(title);
  const contextLines = [];
  if (agendaKind === 'market_segment' || String(agendaKey).startsWith('market:')) {
    contextLines.push('시장 상태, 분위기, 후보 신호, 손실 방지 잠금을 함께 본 자문 안건입니다.');
    contextLines.push('지금 단계에서는 실제 매수·매도 판단이 아니라 회의 기록과 확인 대상을 정리합니다.');
  } else if (String(agendaKey).startsWith('decision:')) {
    contextLines.push('부품 승격 검토(C15)에서 반복 관찰 중인 시스템 구성요소입니다.');
    contextLines.push('충분한 누적 사례와 기준 충족 여부를 보고 다음 논의 대상으로 둘지 판단합니다.');
  } else {
    contextLines.push('회의 데이터와 감사 근거를 바탕으로 남긴 자문 결정입니다.');
    contextLines.push('추가 조치가 필요하면 별도 마스터 실행 경로에서만 다룹니다.');
  }
  return {
    question: existing.question || agendaQuestion(agendaKey, safeTitle),
    context_plain: existing.context_plain || contextLines.join('\n'),
    if_confirm: existing.if_confirm || '확정하면 검토 완료로 감사 기록에 남고, 다음 단계 논의 대상으로 정리됩니다.',
    if_defer: existing.if_defer || '보류하면 같은 안건을 계속 관찰 목록에 두고, 다음 회의에서 다시 확인합니다.',
    safety_label: existing.safety_label || '지금은 기록만 — 실제 거래·파라미터 영향 없음',
    professional_summary: existing.professional_summary || applyMeetingGlossary(input.decision || title),
  };
}

export default {
  applyMeetingGlossary,
  plainDeploymentStatus,
  plainComponentLabel,
  plainRegimeLabel,
  buildDecisionPlainFields,
};
