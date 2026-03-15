'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search, Upload, Download, Trash2, FileText } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth, getToken } from '@/lib/auth-context';
import { canPerformMenuOperation } from '@/lib/menu-access';
import DataTable from '@/components/DataTable';

const CATEGORY_OPTIONS = ['기타', '계약서', '견적서', '세금계산서', '보고서', '회의자료'];

function proposalChanged(original, proposal) {
  if (!original || !proposal) return false;
  return ['filename', 'category', 'request_summary', 'analysis_goal'].some(
    (key) => String(original[key] || '') !== String(proposal[key] || '')
  );
}

export default function DocumentsPage() {
  const { user } = useAuth();
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [uploadCategory, setUploadCategory] = useState('');
  const [prompt, setPrompt] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [proposal, setProposal] = useState(null);
  const [originalProposal, setOriginalProposal] = useState(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const canCreateDocuments = canPerformMenuOperation(user, 'documents', 'create');
  const canDeleteDocuments = canPerformMenuOperation(user, 'documents', 'delete');

  const load = async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (keyword.trim()) params.set('keyword', keyword.trim());
    if (filterCategory) params.set('category', filterCategory);
    try {
      const data = await api.get(`/documents?${params}`);
      setDocuments(data.documents || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []); // eslint-disable-line

  const emptyNode = (
    <div className="text-center py-12">
      <p className="text-4xl mb-3">📎</p>
      <p className="text-gray-500 mb-4">등록된 문서가 없습니다</p>
      <label className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium ${canCreateDocuments ? 'bg-indigo-600 text-white cursor-pointer' : 'bg-slate-200 text-slate-500 cursor-not-allowed'}`}>
        <Upload className="w-4 h-4" />
        첫 문서 업로드
        <input
          type="file"
          className="hidden"
          disabled={!canCreateDocuments}
          onChange={(e) => {
            const file = e.target.files?.[0] || null;
            setSelectedFile(file);
          }}
        />
      </label>
    </div>
  );

  const columns = useMemo(() => ([
    { key: 'filename', label: '문서명' },
    { key: 'category', label: '분류' },
    { key: 'ai_summary', label: '요약', render: (value) => value || '-' },
    { key: 'created_at', label: '등록일', render: (value) => value ? String(value).slice(0, 10) : '-' },
  ]), []);

  const createProposal = async () => {
    if (!prompt.trim()) return;
    setProposalLoading(true);
    setError('');
    setNotice('');
    try {
      const data = await api.post('/documents/proposals', {
        prompt,
        filename: selectedFile?.name || '',
      });
      setProposal(data.proposal || null);
      setOriginalProposal(data.proposal || null);
      setPrompt('');
    } catch (err) {
      setError(err.message);
    } finally {
      setProposalLoading(false);
    }
  };

  const directUpload = async () => {
    if (!selectedFile) {
      setError('업로드할 파일을 선택해주세요.');
      return;
    }
    setUploading(true);
    setError('');
    setNotice('');
    try {
      const token = getToken();
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('category', uploadCategory || '');
      const res = await fetch('/api/documents/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '문서 업로드에 실패했습니다.');
      setNotice('문서를 업로드했습니다.');
      setSelectedFile(null);
      setUploadCategory('');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  const confirmProposal = async () => {
    if (!proposal?.feedback_session_id) return;
    if (!selectedFile) {
      setError('문서 제안을 확정하려면 파일을 선택해주세요.');
      return;
    }
    setActionLoading(true);
    setError('');
    try {
      const token = getToken();
      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('proposal', JSON.stringify(proposal));
      const res = await fetch(`/api/documents/proposals/${proposal.feedback_session_id}/confirm`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '문서 제안 확정에 실패했습니다.');
      setNotice('문서 업로드 제안을 확정했습니다.');
      setProposal(null);
      setOriginalProposal(null);
      setSelectedFile(null);
      setUploadCategory('');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const rejectProposal = async () => {
    if (!proposal?.feedback_session_id) return;
    setActionLoading(true);
    setError('');
    try {
      await api.post(`/documents/proposals/${proposal.feedback_session_id}/reject`, {});
      setNotice('문서 업로드 제안을 반려했습니다.');
      setProposal(null);
      setOriginalProposal(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('문서를 삭제하시겠습니까?')) return;
    try {
      await api.delete(`/documents/${id}`);
      setNotice('문서를 삭제했습니다.');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">📎 문서 관리</h1>
        <label className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium ${canCreateDocuments ? 'bg-indigo-600 text-white cursor-pointer' : 'bg-slate-200 text-slate-500 cursor-not-allowed'}`}>
          <Upload className="w-4 h-4" />
          파일 선택
          <input
            type="file"
            className="hidden"
            disabled={!canCreateDocuments}
            onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
          />
        </label>
      </div>

      <div className="card space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-500">문서 자연어 업로드 제안</p>
            <p className="text-sm text-slate-600 mt-1">
              파일을 먼저 선택한 뒤 자연어로 업로드 목적을 적으면, 카테고리와 요약을 확인한 후 등록합니다.
            </p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
            확인 결과 창 기반 피드백 수집
          </span>
        </div>

        <div className="grid gap-3 lg:grid-cols-[1.6fr_1fr]">
          <textarea
            className="input-base min-h-[96px]"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="예: 이 계약서 업로드하고 검토 요청으로 등록해줘"
          />
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-semibold text-slate-500">선택한 파일</p>
            <p className="mt-2 text-sm font-medium text-slate-900 break-all">
              {selectedFile?.name || '아직 파일을 선택하지 않았습니다.'}
            </p>
            {selectedFile && (
              <p className="mt-1 text-xs text-slate-500">
                {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className="btn-primary"
            onClick={createProposal}
            disabled={!canCreateDocuments || proposalLoading || !prompt.trim()}
          >
            {proposalLoading ? '제안 생성 중...' : '문서 제안 만들기'}
          </button>
          <select className="input-base min-w-[140px]" value={uploadCategory} onChange={(e) => setUploadCategory(e.target.value)}>
            <option value="">자동 분류</option>
            {CATEGORY_OPTIONS.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
          <button
            type="button"
            className="btn-secondary"
            onClick={directUpload}
            disabled={!canCreateDocuments || uploading || !selectedFile}
          >
            {uploading ? '업로드 중...' : '바로 업로드'}
          </button>
        </div>

        {error && <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
        {notice && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}
      </div>

      {proposal && (
        <div className="card space-y-4 border-sky-200 bg-sky-50/40">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-sky-700">확인 결과 창</p>
              <h2 className="text-lg font-semibold text-slate-900 mt-1">{proposal.summary}</h2>
              <p className="text-sm text-slate-600 mt-1">
                문서 업로드 요청을 해석한 결과입니다. 분류와 업로드 목적을 확인한 뒤 확정하세요.
              </p>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs font-semibold border ${proposalChanged(originalProposal, proposal)
              ? 'border-amber-200 bg-amber-50 text-amber-700'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
              {proposalChanged(originalProposal, proposal) ? '수정 있음' : '수정 없음'}
            </span>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-500">파일명</span>
              <input
                className="input-base"
                value={proposal.filename || selectedFile?.name || ''}
                onChange={(e) => setProposal((prev) => ({ ...prev, filename: e.target.value, summary: `${prev.category || '기타'} 문서 업로드 · ${e.target.value || '파일 선택 필요'}` }))}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-500">분류</span>
              <select
                className="input-base"
                value={proposal.category || '기타'}
                onChange={(e) => setProposal((prev) => ({ ...prev, category: e.target.value, summary: `${e.target.value} 문서 업로드 · ${prev.filename || selectedFile?.name || ''}`.trim() }))}
              >
                {CATEGORY_OPTIONS.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="space-y-1 block">
            <span className="text-xs font-semibold text-slate-500">업로드 목적 / 요약</span>
            <textarea
              className="input-base min-h-[96px]"
              value={proposal.request_summary || ''}
              onChange={(e) => setProposal((prev) => ({ ...prev, request_summary: e.target.value }))}
            />
          </label>

          <label className="space-y-1 block">
            <span className="text-xs font-semibold text-slate-500">추가 분석 목표</span>
            <textarea
              className="input-base min-h-[84px]"
              value={proposal.analysis_goal || ''}
              onChange={(e) => setProposal((prev) => ({ ...prev, analysis_goal: e.target.value }))}
              placeholder="예: 위약금 조항 검토, 보고서 요약, 회의자료 분류"
            />
          </label>

          {Array.isArray(proposal.similar_cases) && proposal.similar_cases.length > 0 && (
            <div className="rounded-2xl border border-violet-200 bg-violet-50/70 px-4 py-4">
              <p className="text-sm font-semibold text-violet-900">유사 확정 사례</p>
              <div className="mt-3 space-y-2">
                {proposal.similar_cases.map((item) => (
                  <div key={item.id} className="rounded-xl border border-violet-100 bg-white/90 px-3 py-3 text-sm text-slate-700">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-medium text-slate-900">{item.summary || `${item.flow_code}/${item.action_code}`}</p>
                      <span className="text-xs text-violet-500">{Math.round((item.similarity || 0) * 100)}%</span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-slate-600">{item.preview}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-3">
            <button type="button" className="btn-secondary flex-1" onClick={rejectProposal} disabled={actionLoading}>
              반려
            </button>
            <button
              type="button"
              className="btn-primary flex-1"
              onClick={confirmProposal}
              disabled={actionLoading || !selectedFile}
            >
              {actionLoading ? '확정 중...' : '업로드 확정'}
            </button>
          </div>
        </div>
      )}

      <div className="card space-y-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-900">문서 내역</p>
            <p className="text-sm text-slate-500 mt-1">업로드된 문서를 조회하고 다운로드하거나 삭제합니다.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                className="input-base pl-9"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="파일명/요약 검색"
              />
            </div>
            <select className="input-base" value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
              <option value="">전체 분류</option>
              {CATEGORY_OPTIONS.map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
            <button type="button" className="btn-secondary" onClick={load}>조회</button>
          </div>
        </div>

        <DataTable
          columns={columns}
          data={documents}
          pageSize={10}
          emptyNode={emptyNode}
          actions={(row) => (
            <div className="flex justify-end gap-2">
              <a
                href={row.download_url}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                <Download className="w-3.5 h-3.5" />
                다운로드
              </a>
              {canDeleteDocuments && (
                <button
                  type="button"
                  onClick={() => handleDelete(row.id)}
                  className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  삭제
                </button>
              )}
            </div>
          )}
        />
      </div>

      {selectedFile && !proposal && (
        <div className="rounded-2xl border border-indigo-100 bg-indigo-50/50 px-4 py-3 text-sm text-indigo-700">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4" />
            <span className="font-medium">{selectedFile.name}</span>
          </div>
          <p className="mt-1">
            자연어 제안을 만들거나, 바로 업로드 버튼으로 등록할 수 있습니다.
          </p>
        </div>
      )}
    </div>
  );
}
