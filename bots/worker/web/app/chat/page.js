import WorkerAIWorkspace from '@/components/WorkerAIWorkspace';

const SUGGESTIONS = [
  '오늘 일정 보여줘',
  '내일 오전 10시 김대리 업체 미팅 잡아줘',
  '이번 주 매출 요약해줘',
  '직원 목록 보여줘',
];

export default function WorkerChatPage() {
  return (
    <WorkerAIWorkspace
      menuKey="chat"
      title="AI 업무 대화"
      description="Worker 팀장과 자연어로 대화하며 업무를 등록하고 실행 흐름으로 연결합니다."
      suggestions={SUGGESTIONS}
      allowUpload
    />
  );
}
