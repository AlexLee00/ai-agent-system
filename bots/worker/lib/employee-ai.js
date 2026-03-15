'use strict';

function inferStatus(prompt = '') {
  return /퇴직/.test(prompt) ? 'resigned' : 'active';
}

function inferDepartment(prompt = '') {
  const match = String(prompt).match(/(영업|개발|마케팅|운영|재무|인사|관리|디자인|기획)\s*팀?/);
  return match ? `${match[1]}팀` : '';
}

function inferPosition(prompt = '') {
  const match = String(prompt).match(/(사원|대리|과장|차장|부장|이사|대표|인턴|매니저|팀장)/);
  return match ? match[1] : '';
}

function inferHireDate(prompt = '') {
  const explicit = String(prompt).match(/(20\d{2})[-/.년 ]\s*(\d{1,2})[-/.월 ]\s*(\d{1,2})/);
  if (explicit) {
    const [, year, month, day] = explicit;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return '';
}

function inferPhone(prompt = '') {
  const match = String(prompt).match(/(01[0-9]-?\d{3,4}-?\d{4})/);
  return match ? match[1] : '';
}

function inferBaseSalary(prompt = '') {
  const match = String(prompt).match(/(\d[\d,]*)\s*만?원/);
  if (!match) return '';
  const numeric = Number(String(match[1]).replace(/[^\d]/g, ''));
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  return /만원/.test(match[0]) ? String(numeric * 10000) : String(numeric);
}

function inferName(prompt = '') {
  const text = String(prompt).trim();
  const patterns = [
    /([가-힣]{2,4})\s*(직원|사원|대리|과장|차장|부장|팀장|매니저|님)\s*(등록|추가|입사)/,
    /([가-힣]{2,4})\s*(등록|추가|입사)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return '';
}

function normalizeEmployeeProposal(proposal = {}) {
  return {
    name: String(proposal.name || '').trim(),
    position: String(proposal.position || '').trim(),
    department: String(proposal.department || '').trim(),
    phone: String(proposal.phone || '').trim(),
    hire_date: String(proposal.hire_date || '').trim(),
    status: proposal.status === 'resigned' ? 'resigned' : 'active',
    base_salary: String(proposal.base_salary || '').trim(),
    summary: String(proposal.name || '').trim()
      ? `${String(proposal.name || '').trim()} ${String(proposal.position || '').trim() || '직원'} 등록 제안`
      : '직원 등록 제안',
    confidence: proposal.confidence || 'medium',
    parser_meta: proposal.parser_meta || {},
  };
}

function buildEmployeeProposal({ prompt = '' }) {
  const name = inferName(prompt);
  if (!name) {
    throw new Error('직원 이름을 이해하지 못했습니다. 예: "김민수 대리 영업팀 직원 등록해줘"');
  }
  return normalizeEmployeeProposal({
    name,
    position: inferPosition(prompt),
    department: inferDepartment(prompt),
    phone: inferPhone(prompt),
    hire_date: inferHireDate(prompt),
    status: inferStatus(prompt),
    base_salary: inferBaseSalary(prompt),
    confidence: 'medium',
    parser_meta: {
      parser: 'rule-based-employee',
      prompt,
    },
  });
}

module.exports = {
  buildEmployeeProposal,
  normalizeEmployeeProposal,
};

