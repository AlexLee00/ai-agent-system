'use client';

import { useRef, useState } from 'react';
import { getToken } from '@/lib/auth-context';
import AdminQuickNav from '@/components/AdminQuickNav';
import AdminPageHero from '@/components/AdminPageHero';

function formatWarnings(warnings = []) {
  if (!Array.isArray(warnings) || warnings.length === 0) return ['없음'];
  return warnings;
}

export default function OcrTestPage() {
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [documentInfo, setDocumentInfo] = useState(null);
  const [extraction, setExtraction] = useState(null);

  async function handleUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);
    setUploading(true);
    setError('');
    setNotice('');

    try {
      const token = getToken();
      const uploadRes = await fetch('/api/documents/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      const uploadData = await uploadRes.json().catch(() => ({}));
      if (!uploadRes.ok) throw new Error(uploadData.error || '파일 업로드 실패');

      setDocumentInfo(uploadData.document || null);

      const extractionRes = await fetch(`/api/documents/${uploadData.document.id}/extraction`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const extractionData = await extractionRes.json().catch(() => ({}));
      if (!extractionRes.ok) throw new Error(extractionData.error || '파싱 결과 조회 실패');

      setExtraction(extractionData.document || null);
      setNotice(`"${uploadData.document.filename}" 문서를 업로드하고 파싱 결과를 불러왔습니다.`);
    } catch (err) {
      setError(err.message || 'OCR 테스트 중 오류가 발생했습니다.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const metadata = extraction?.extraction_metadata || {};

  return (
    <div className="space-y-6">
      <AdminQuickNav />

      <AdminPageHero
        title="OCR 테스트"
        description="지원 문서(pdf, txt, doc, docx, xlsx, pptx, 이미지)를 업로드하고, 파싱 결과와 metadata를 바로 확인하는 내부 테스트 화면입니다."
        stats={[
          { label: '최근 문서', value: documentInfo?.filename || '-', caption: '업로드 기준' },
          { label: '추출 방식', value: metadata.extractionMethod || '-', caption: 'metadata 기준' },
          { label: '텍스트 길이', value: metadata.analysisReadyTextLength || 0, caption: 'analysis ready chars' },
        ]}
      />

      <div className="card space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-900">파일 업로드</p>
            <p className="mt-1 text-sm text-slate-500">`pdf`, `txt`, `doc`, `docx`, `xlsx`, `pptx`, `png/jpg/jpeg/webp` 파일을 바로 테스트할 수 있습니다.</p>
          </div>
          <div className="flex gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.txt,.doc,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.webp"
              className="hidden"
              onChange={handleUpload}
            />
            <button
              type="button"
              className="btn-primary"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? '업로드 중...' : '파일 선택'}
            </button>
          </div>
        </div>

        {error && <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
        {notice && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="card space-y-4">
          <div>
            <p className="text-sm font-semibold text-slate-900">파싱 metadata</p>
            <p className="mt-1 text-sm text-slate-500">문서 파서가 어떤 경로로 텍스트를 추출했는지 확인합니다.</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs font-medium text-slate-500">문서 유형</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">{metadata.sourceFileType || '-'}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs font-medium text-slate-500">추출 방식</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">{metadata.extractionMethod || '-'}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs font-medium text-slate-500">페이지/등가 개수</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">{metadata.pageCount ?? '-'}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs font-medium text-slate-500">신뢰도</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">{metadata.sourceConfidence ?? '-'}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs font-medium text-slate-500">이미지 품질 severity</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">{metadata.imageQualitySeverity || '-'}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs font-medium text-slate-500">이미지 OCR confidence</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">{metadata.imageOcrConfidence ?? metadata.ocrConfidence ?? '-'}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs font-medium text-slate-500">희소 텍스트 여부</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">{String(Boolean(metadata.imageEstimatedSparseText))}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs font-medium text-slate-500">보수 처리 적용 여부</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">{String(Boolean(metadata.imageConservativeHandling))}</p>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white px-4 py-4">
            <p className="text-xs font-medium text-slate-500">Warnings</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {formatWarnings(metadata.extractionWarnings).map((warning) => (
                <span key={warning} className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
                  {warning}
                </span>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs font-medium text-slate-500">이미지 크기</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">
                {metadata.imageWidth && metadata.imageHeight ? `${metadata.imageWidth} x ${metadata.imageHeight}` : '-'}
              </p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs font-medium text-slate-500">품질 점수</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">{metadata.imageOcrQualityScore ?? '-'}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs font-medium text-slate-500">텍스트 밀도</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">{metadata.imageTextDensity ?? '-'}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs font-medium text-slate-500">라인 밀도</p>
              <p className="mt-2 text-sm font-semibold text-slate-900">{metadata.imageLineDensity ?? '-'}</p>
            </div>
          </div>
        </div>

        <div className="card space-y-4">
          <div>
            <p className="text-sm font-semibold text-slate-900">파싱 결과 텍스트</p>
            <p className="mt-1 text-sm text-slate-500">현재는 기능만 구현하고, 추후 다른 페이지에 재사용할 수 있게 전체 텍스트를 그대로 보여줍니다.</p>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-slate-950 px-4 py-4">
            <pre className="max-h-[42rem] overflow-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-100">
              {extraction?.extracted_text || '업로드 후 파싱 결과가 여기에 표시됩니다.'}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
