// @ts-nocheck
'use strict';

const AGENT_INTRO_SERIES_NAME = '에이전트 입문';
const LEGACY_AGENT_INTRO_SERIES_NAME = 'ChatGPT Codex와 Claude Code로 따라 만드는 실전 AI 구현 입문';
const AGENT_INTRO_FIXED_KEYWORDS = ['claude code', 'codex', 'AI 에이전트'];

const AGENT_INTRO_CURRICULUM = [
  { lecture: 1, section: 'S1', title: 'AI 코딩 에이전트 이해와 첫 실습 준비', keywords: ['AI 코딩 에이전트', '첫 실습', '준비'] },
  { lecture: 2, section: 'S1', title: 'Codex vs Claude Code 비교', keywords: ['Codex', 'Claude Code', '비교'] },
  { lecture: 3, section: 'S1', title: '실습 폴더와 Git 기본 환경', keywords: ['실습 폴더', 'Git', '환경'] },
  { lecture: 4, section: 'S1', title: '프롬프트 한 줄로 웹페이지 초안', keywords: ['프롬프트', '웹페이지', '초안'] },
  { lecture: 5, section: 'S1', title: 'Claude Code 설치 따라하기', keywords: ['Claude Code', '설치', '따라하기'] },
  { lecture: 6, section: 'S1', title: 'Codex 설치 따라하기', keywords: ['Codex', '설치', '따라하기'] },
  { lecture: 7, section: 'S1', title: '터미널 무서워하지 않기', keywords: ['터미널', '명령어', '입문'] },
  { lecture: 8, section: 'S1', title: '에이전트와 첫 대화', keywords: ['에이전트', '첫 대화', '질문'] },
  { lecture: 9, section: 'S2', title: '좋은 프롬프트 vs 나쁜 프롬프트', keywords: ['좋은 프롬프트', '나쁜 프롬프트', '비교'] },
  { lecture: 10, section: 'S2', title: '구체적으로 말하는 법', keywords: ['구체적 지시', '프롬프트', '맥락'] },
  { lecture: 11, section: 'S2', title: '큰 일은 단계로 나누기', keywords: ['작업 분해', '단계', '계획'] },
  { lecture: 12, section: 'S2', title: '예시 들어주기', keywords: ['예시', '샘플', '프롬프트'] },
  { lecture: 13, section: 'S2', title: 'CLAUDE.md로 내 상황 알려주기', keywords: ['CLAUDE.md', '프로젝트 맥락', '지시문'] },
  { lecture: 14, section: 'S2', title: '자주 하는 실수 5가지', keywords: ['실수', '프롬프트 오류', '개선'] },
  { lecture: 15, section: 'S2', title: '"계획부터 보여줘" 기법', keywords: ['계획', '검토', '작업 전 확인'] },
  { lecture: 16, section: 'S2', title: '결과 다듬는 대화법', keywords: ['결과 개선', '피드백', '반복'] },
  { lecture: 17, section: 'S3', title: '파일 읽고 고치게 하기', keywords: ['파일 읽기', '파일 수정', '에이전트 도구'] },
  { lecture: 18, section: 'S3', title: '스크린샷과 이미지 활용', keywords: ['스크린샷', '이미지', '시각 자료'] },
  { lecture: 19, section: 'S3', title: '웹 검색 시키기', keywords: ['웹 검색', '최신 정보', '검증'] },
  { lecture: 20, section: 'S3', title: '긴 작업 맡기기', keywords: ['긴 작업', '진행 관리', '자율 작업'] },
  { lecture: 21, section: 'S3', title: 'git으로 되돌리기(안전망)', keywords: ['git', '되돌리기', '안전망'] },
  { lecture: 22, section: 'S3', title: '결과 검증 습관', keywords: ['검증', '테스트', '확인'] },
  { lecture: 23, section: 'S3', title: '비용과 한도 이해', keywords: ['비용', '한도', '토큰'] },
  { lecture: 24, section: 'S3', title: '권한과 안전 설정', keywords: ['권한', '안전 설정', '승인'] },
  { lecture: 25, section: 'S4', title: '파일 정리 자동화', keywords: ['파일 정리', '자동화', '폴더'] },
  { lecture: 26, section: 'S4', title: '엑셀·CSV 정리', keywords: ['엑셀', 'CSV', '데이터 정리'] },
  { lecture: 27, section: 'S4', title: '이메일 초안 비서', keywords: ['이메일', '초안', '비서'] },
  { lecture: 28, section: 'S4', title: '회의록 요약', keywords: ['회의록', '요약', '업무 자동화'] },
  { lecture: 29, section: 'S4', title: '사진 일괄 이름변경', keywords: ['사진', '일괄 변경', '파일명'] },
  { lecture: 30, section: 'S4', title: '간단 웹페이지 만들기', keywords: ['웹페이지', 'HTML', '초보 프로젝트'] },
  { lecture: 31, section: 'S4', title: 'PDF 요약', keywords: ['PDF', '요약', '문서'] },
  { lecture: 32, section: 'S4', title: '데이터 차트', keywords: ['데이터', '차트', '시각화'] },
  { lecture: 33, section: 'S4', title: '일정 정리', keywords: ['일정', '정리', '캘린더'] },
  { lecture: 34, section: 'S4', title: '종합 연습', keywords: ['종합 연습', '미니 프로젝트', '복습'] },
  { lecture: 35, section: 'S5', title: '에이전트 = 지시문+도구', keywords: ['에이전트', '지시문', '도구'] },
  { lecture: 36, section: 'S5', title: 'CLAUDE.md로 나만의 비서', keywords: ['CLAUDE.md', '개인 비서', '커스텀'] },
  { lecture: 37, section: 'S5', title: '커스텀 명령어', keywords: ['커스텀 명령어', '명령', '반복 작업'] },
  { lecture: 38, section: 'S5', title: '스케줄 자동 실행 맛보기', keywords: ['스케줄', '자동 실행', '반복 작업'] },
  { lecture: 39, section: 'S5', title: 'MCP로 도구 연결 맛보기', keywords: ['MCP', '도구 연결', '확장'] },
  { lecture: 40, section: 'S5', title: '에이전트에게 자기검증 시키기', keywords: ['자기검증', '검증 루프', '품질 확인'] },
  { lecture: 41, section: 'S5', title: '작은 자동화 비서 완성 (상)', keywords: ['자동화 비서', '프로젝트', '상편'] },
  { lecture: 42, section: 'S5', title: '작은 자동화 비서 완성 (하)', keywords: ['자동화 비서', '프로젝트', '하편'] },
  { lecture: 43, section: 'S6', title: '에이전트 협업 습관', keywords: ['협업 습관', '에이전트 활용', '업무 방식'] },
  { lecture: 44, section: 'S6', title: '공식문서·커뮤니티 활용법', keywords: ['공식문서', '커뮤니티', '학습'] },
  { lecture: 45, section: 'S6', title: '트러블슈팅', keywords: ['트러블슈팅', '오류 해결', '디버깅'] },
  { lecture: 46, section: 'S6', title: '종합 프로젝트 (상)', keywords: ['종합 프로젝트', '상편', '실습'] },
  { lecture: 47, section: 'S6', title: '종합 프로젝트 (하)', keywords: ['종합 프로젝트', '하편', '완성'] },
  { lecture: 48, section: 'S6', title: '수료와 다음 과정 예고', keywords: ['수료', '다음 과정', '로드맵'] },
];

function normalizeText(value = '') {
  return String(value || '').trim();
}

function isAgentIntroLecture(seriesName = '', lectureTitle = '') {
  const source = `${seriesName || ''} ${lectureTitle || ''}`;
  return (
    source.includes(AGENT_INTRO_SERIES_NAME)
    || source.includes(LEGACY_AGENT_INTRO_SERIES_NAME)
    || /실전\s*AI\s*구현|Codex|Claude\s*Code|ChatGPT\s*Codex/i.test(source)
  );
}

function normalizeAgentIntroLectureTitle(lectureNumber, lectureTitle = '') {
  const number = Number(lectureNumber || 0);
  const cleaned = normalizeText(lectureTitle)
    .replace(/^\s*\[[^\]]*?\d+강\]\s*/u, '')
    .replace(/^\s*\d+\s*강[:.\s-]*/u, '')
    .trim();
  if (!number) return cleaned || AGENT_INTRO_SERIES_NAME;
  return `[${AGENT_INTRO_SERIES_NAME} ${number}강] ${cleaned || `제${number}강`}`;
}

function buildAgentIntroSearchKeywords(lecture = {}) {
  const values = [
    ...(Array.isArray(lecture.keywords) ? lecture.keywords : []),
    lecture.title,
    ...AGENT_INTRO_FIXED_KEYWORDS,
  ];
  const seen = new Set();
  return values
    .map((item) => normalizeText(item).toLowerCase())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    })
    .slice(0, 10);
}

function findAgentIntroLecture(lectureNumber) {
  const number = Number(lectureNumber || 0);
  return AGENT_INTRO_CURRICULUM.find((row) => row.lecture === number) || null;
}

module.exports = {
  AGENT_INTRO_SERIES_NAME,
  LEGACY_AGENT_INTRO_SERIES_NAME,
  AGENT_INTRO_FIXED_KEYWORDS,
  AGENT_INTRO_CURRICULUM,
  isAgentIntroLecture,
  normalizeAgentIntroLectureTitle,
  buildAgentIntroSearchKeywords,
  findAgentIntroLecture,
};
