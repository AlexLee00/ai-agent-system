'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function DocumentsRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/journals');
  }, [router]);

  return (
    <div className="card max-w-xl mx-auto mt-10 text-center">
      <h1 className="text-lg font-semibold text-slate-900">문서 관리는 AI 업무대화에 통합되었습니다.</h1>
      <p className="text-sm text-slate-500 mt-2">
        파일 업로드와 문서 요청은 업무 관리 화면 상단의 AI 패널에서 바로 진행할 수 있습니다.
      </p>
    </div>
  );
}
