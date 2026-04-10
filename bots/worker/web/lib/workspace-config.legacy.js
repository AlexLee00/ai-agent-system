'use client';

import { resolveMenuKey } from '@/lib/menu-access';

const DEFAULT_CONFIG = {
  title: '공용 업무 프롬프트',
  description: '하나의 프롬프트 창에서 자연어로 요청하고, 메뉴별 결과와 리스트에서 후속 처리를 이어갑니다.',
  suggestions: ['오늘 일정 보여줘', '이번 주 매출 요약해줘', '대기 승인 업무 보여줘'],
  allowUpload: false,
  agentLabel: {
    member: 'Worker 팀장',
    admin: 'Worker 운영 에이전트',
    master: 'Worker 마스터 오케스트레이터',
  },
};

const MENU_CONFIG = {
  dashboard: {
    title: '대시보드 공용 프롬프트',
    description: '운영 요약, 승인 대기, 미출근 직원 같은 관리 요청을 하나의 프롬프트 창에서 처리합니다.',
    suggestions: ['오늘 미출근 직원 보여줘', '대기 승인 업무 보여줘', '오늘 일정 요약해줘'],
    allowUpload: false,
    agentLabel: {
      member: 'Worker 팀장',
      admin: 'Worker 운영 에이전트',
      master: 'Worker 마스터 오케스트레이터',
    },
  },
  attendance: {
    title: '근태 공용 프롬프트',
    description: '출근, 퇴근, 휴가, 근태 현황 요청을 하나의 프롬프트 창에서 처리합니다.',
    suggestions: ['출근했어요', '퇴근합니다', '내일 연차 신청', '오늘 미출근 직원 보여줘'],
    allowUpload: false,
    agentLabel: {
      member: 'Noah 근태 에이전트',
      admin: 'Noah 근태 운영 에이전트',
      master: 'Noah 근태 오케스트레이터',
    },
  },
  schedules: {
    title: '일정 공용 프롬프트',
    description: '일정 등록, 수정, 조회를 하나의 프롬프트 창에서 시작하고 아래 리스트에서 확정합니다.',
    suggestions: ['내일 오전 10시 미팅 잡아줘', '오늘 일정 보여줘', '이번 주 일정 요약해줘'],
    allowUpload: true,
    agentLabel: {
      member: 'Chloe 일정 에이전트',
      admin: 'Chloe 일정 운영 에이전트',
      master: 'Chloe 일정 오케스트레이터',
    },
  },
  employees: {
    title: '직원 관리 공용 프롬프트',
    description: '직원 등록, 수정, 인사 요청을 하나의 프롬프트 창에서 시작합니다.',
    suggestions: ['신입 직원 등록해줘', '직원 목록 보여줘', '이번 주 휴가자 정리해줘'],
    allowUpload: false,
    agentLabel: {
      member: 'Noah 인사 에이전트',
      admin: 'Noah 인사 운영 에이전트',
      master: 'Noah 인사 오케스트레이터',
    },
  },
  payroll: {
    title: '급여 관리 공용 프롬프트',
    description: '급여 계산, 조회, 수정 요청을 하나의 프롬프트 창에서 처리합니다.',
    suggestions: ['이번 달 급여 계산해줘', '급여 명세서 보여줘', '급여 수정 요청 목록 보여줘'],
    allowUpload: false,
    agentLabel: {
      member: 'Sophie 급여 에이전트',
      admin: 'Sophie 급여 운영 에이전트',
      master: 'Sophie 급여 오케스트레이터',
    },
  },
  sales: {
    title: '매출 관리 공용 프롬프트',
    description: '매출 등록과 조회를 하나의 프롬프트 창에서 시작하고 아래 리스트에서 확정합니다.',
    suggestions: ['오늘 상품판매 5만원 매출 등록해줘', '이번 주 매출 요약해줘', '어제 매출 내역 보여줘'],
    allowUpload: true,
    agentLabel: {
      member: 'Oliver 매출 에이전트',
      admin: 'Oliver 매출 운영 에이전트',
      master: 'Oliver 매출 오케스트레이터',
    },
  },
  projects: {
    title: '프로젝트 공용 프롬프트',
    description: '프로젝트 생성, 수정, 상태 조회를 하나의 프롬프트 창에서 시작합니다.',
    suggestions: ['신규 프로젝트 만들어줘', '진행 중 프로젝트 보여줘', '이번 주 마일스톤 정리해줘'],
    allowUpload: true,
    agentLabel: {
      member: 'Ryan 프로젝트 에이전트',
      admin: 'Ryan 프로젝트 운영 에이전트',
      master: 'Ryan 프로젝트 오케스트레이터',
    },
  },
  journals: {
    title: '업무일지 공용 프롬프트',
    description: '업무 기록, 보고 초안, 회고 요청을 하나의 프롬프트 창에서 처리합니다.',
    suggestions: ['오늘 업무일지 작성해줘', '지난주 업무 요약해줘', '회의 내용 정리해줘'],
    allowUpload: true,
    agentLabel: {
      member: 'Ryan 업무일지 에이전트',
      admin: 'Ryan 업무 운영 에이전트',
      master: 'Ryan 업무 오케스트레이터',
    },
  },
  chat: {
    title: '공용 업무 프롬프트',
    description: '워커 팀장과 자연어로 대화하며 업무를 등록하고 실행 흐름으로 연결합니다.',
    suggestions: ['오늘 일정 보여줘', '내일 오전 10시 김대리 업체 미팅 잡아줘', '이번 주 매출 요약해줘', '직원 목록 보여줘'],
    allowUpload: true,
    agentLabel: {
      member: 'Worker 팀장',
      admin: 'Worker 운영 에이전트',
      master: 'Worker 마스터 오케스트레이터',
    },
  },
};

export function getWorkspaceConfig(pathname = '/', user = null) {
  const menuKey = resolveMenuKey(pathname);
  const role = user?.role === 'master' ? 'master' : user?.role === 'admin' ? 'admin' : 'member';
  const config = MENU_CONFIG[menuKey] || DEFAULT_CONFIG;

  return {
    menuKey: menuKey || 'chat',
    title: config.title,
    description: config.description,
    suggestions: config.suggestions || [],
    allowUpload: Boolean(config.allowUpload),
    agentName: config.agentLabel?.[role] || DEFAULT_CONFIG.agentLabel[role],
  };
}
