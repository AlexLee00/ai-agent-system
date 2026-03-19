'use client';
import { useState, useEffect, useRef } from 'react';
import { Search } from 'lucide-react';
import { api } from '@/lib/api';
import { getToken, useAuth } from '@/lib/auth-context';
import { canPerformMenuOperation } from '@/lib/menu-access';
import AdminQuickNav from '@/components/AdminQuickNav';
import AdminPageHero from '@/components/AdminPageHero';
import DataTable from '@/components/DataTable';
import Modal from '@/components/Modal';
import PendingReviewSection from '@/components/PendingReviewSection';
import PromptAdvisor from '@/components/PromptAdvisor';
import OperationsSectionHeader from '@/components/OperationsSectionHeader';
import { buildDocumentPromptAppendix, buildDocumentUploadNotice, mergePromptWithDocumentContext } from '@/lib/document-attachment';
import { consumeDocumentReuseDraft } from '@/lib/document-reuse-draft';
import useAutoResizeTextarea from '@/lib/useAutoResizeTextarea';

const CATEGORIES = [
  { value: 'general', label: '일일업무' },
  { value: 'meeting', label: '미팅' },
  { value: 'report',  label: '보고' },
  { value: 'other',   label: '기타' },
];

const today = () => new Date().toISOString().slice(0, 10);
const EMPTY_FORM = { date: today(), content: '', category: 'general' };
const EMPTY_PROPOSAL = { date: today(), content: '', category: 'general' };

function proposalChanged(original, proposal) {
  if (!original || !proposal) return false;
  return ['date', 'category', 'content'].some((key) => (original[key] || '') !== (proposal[key] || ''));
}

function normalizeJournalCategory(value) {
  return value === 'task' || value === 'daily_work' ? 'general' : value;
}

export default function JournalsPage() {
  const { user } = useAuth();
  const [journals,   setJournals]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [filterDate, setFilterDate] = useState('');
  const [filterCat,  setFilterCat]  = useState('');
  const [search,     setSearch]     = useState('');
  const [showSearchInput, setShowSearchInput] = useState(false);
  const [modal,      setModal]      = useState(false);
  const [viewModal,  setViewModal]  = useState(false);
  const [viewItem,   setViewItem]   = useState(null);
  const [form,       setForm]       = useState(EMPTY_FORM);
  const [editId,     setEditId]     = useState(null);
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState('');
  const [prompt, setPrompt] = useState('');
  const [proposal, setProposal] = useState(null);
  const [originalProposal, setOriginalProposal] = useState(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [proposalActionLoading, setProposalActionLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [uploading, setUploading] = useState(false);
  const [attachedFileName, setAttachedFileName] = useState('');
  const [attachedDocumentContext, setAttachedDocumentContext] = useState('');
  const [reusedDocument, setReusedDocument] = useState(null);
  const fileRef = useRef(null);
  const promptRef = useRef(null);
  const searchInputRef = useRef(null);

  useAutoResizeTextarea(promptRef, prompt);

  const load = (overrides = {}) => {
    setLoading(true);
    const params = new URLSearchParams();
    const date = overrides.date ?? filterDate;
    const category = overrides.category ?? filterCat;
    const keyword = overrides.keyword ?? search;
    if (date) params.set('date', date);
    if (category) params.set('category', category);
    if (keyword) params.set('keyword', keyword);
    api.get(`/journals?${params}`)
      .then(d => setJournals(d.journals || []))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [filterDate, filterCat]); // eslint-disable-line
  useEffect(() => {
    const reusedDraft = consumeDocumentReuseDraft('journals');
    if (reusedDraft?.draft) {
      setPrompt(reusedDraft.draft);
      setReusedDocument(reusedDraft);
    }
  }, []);

  useEffect(() => {
    if (!showSearchInput) return;
    searchInputRef.current?.focus();
  }, [showSearchInput]);

  const openNew  = () => { setForm(EMPTY_FORM); setEditId(null); setError(''); setModal(true); };
  const openEdit = (j) => {
    setForm({
      date: j.date?.slice(0, 10) || today(),
      content: j.content || '',
      category: normalizeJournalCategory(j.category || 'general'),
    });
    setEditId(j.id); setError(''); setModal(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.content.trim()) { setError('내용을 입력해주세요.'); return; }
    setSaving(true); setError('');
    try {
      if (editId) await api.put(`/journals/${editId}`, form);
      else        await api.post('/journals', form);
      setModal(false); load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('정말 삭제하시겠습니까?')) return;
    await api.delete(`/journals/${id}`).catch(() => {});
    load();
  };

  const createProposal = async () => {
    if (!(prompt.trim() || attachedDocumentContext.trim())) return;
    setProposalLoading(true);
    setError('');
    setNotice('');
    try {
      const data = await api.post('/journals/proposals', {
        prompt: mergePromptWithDocumentContext(prompt, attachedDocumentContext),
      });
      setProposal(data.proposal || EMPTY_PROPOSAL);
      setOriginalProposal(data.proposal || EMPTY_PROPOSAL);
      setPrompt('');
      setAttachedFileName('');
      setAttachedDocumentContext('');
    } catch (err) {
      setError(err.message);
    } finally {
      setProposalLoading(false);
    }
  };

  const confirmProposal = async () => {
    if (!proposal?.feedback_session_id) return;
    setProposalActionLoading(true);
    setError('');
    try {
      await api.post(`/journals/proposals/${proposal.feedback_session_id}/confirm`, {
        proposal,
        reuse_event_id: reusedDocument?.reuseEventId || null,
      });
      setNotice('업무일지를 등록했습니다.');
      setProposal(null);
      setOriginalProposal(null);
      setReusedDocument(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setProposalActionLoading(false);
    }
  };

  const rejectProposal = async () => {
    if (!proposal?.feedback_session_id) return;
    setProposalActionLoading(true);
    setError('');
    try {
      await api.post(`/journals/proposals/${proposal.feedback_session_id}/reject`);
      setNotice('업무일지 제안을 반려했습니다.');
      setProposal(null);
      setOriginalProposal(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setProposalActionLoading(false);
    }
  };

  const handleUpload = async (input) => {
    const file = input instanceof File ? input : input?.target?.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    setUploading(true);
    setError('');
    try {
      const token = getToken();
      const res = await fetch('/api/documents/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '파일 업로드 실패');
      const filename = data.document?.filename || file.name;
      const appendix = buildDocumentPromptAppendix(data.document, file.name);
      setAttachedFileName(filename);
      setAttachedDocumentContext(appendix);
      setNotice(buildDocumentUploadNotice(data.document, file.name));
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const catLabel = (v) => {
    if (v === 'general' || v === 'task') return '일일업무';
    return CATEGORIES.find(c => c.value === v)?.label || v;
  };
  const todayDate = today();
  const todayCount = journals.filter(item => (item.date || '').slice(0, 10) === todayDate).length;
  const categorySummary = CATEGORIES
    .filter(item => item.value)
    .map(item => ({
      label: item.label,
      count: journals.filter(row => normalizeJournalCategory(row.category) === item.value).length,
    }))
    .filter(item => item.count > 0)
    .slice(0, 4);

  const columns = [
    { key: 'date',          label: '날짜',   render: v => v?.slice(0, 10) || '-' },
    { key: 'employee_name', label: '작성자' },
    { key: 'category',      label: '분류',   render: v => catLabel(v) },
    { key: 'content',       label: '내용',   render: v => v?.length > 50 ? v.slice(0, 50) + '…' : v },
  ];

  const canCreateJournals = canPerformMenuOperation(user, 'journals', 'create');
  const canUpdateJournals = canPerformMenuOperation(user, 'journals', 'update');
  const canDeleteJournals = canPerformMenuOperation(user, 'journals', 'delete');

  const emptyNode = (
    <div className="text-center py-12">
      <p className="text-4xl mb-3">📝</p>
      <p className="text-gray-500 mb-4">
        {canCreateJournals ? '오늘의 업무를 기록해보세요' : '현재 조회 조건에 맞는 업무일지가 없습니다.'}
      </p>
      {canCreateJournals ? (
        <button onClick={openNew} className="btn-primary text-sm">
          + 업무일지 작성하기
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      {user?.role !== 'member' && <AdminQuickNav />}

      <AdminPageHero
        title="업무 관리"
        description="업무일지 초안, 카테고리 필터, 검색과 상세 열람을 한 화면에서 운영합니다."
        stats={[
          {
            label: '전체 기록',
            value: `${journals.length || 0}건`,
            caption: '현재 조회 기준',
            body: '현재 필터 기준으로 확인되는 업무일지 수입니다.',
          },
          {
            label: '오늘 기록',
            value: `${todayCount || 0}건`,
            caption: todayDate,
            body: '오늘 날짜로 등록된 업무일지 건수입니다.',
          },
          {
            label: '분류 수',
            value: `${categorySummary.length || 0}개`,
            caption: '표시된 카테고리',
            body: '현재 조회 결과에서 나타나는 업무 분류 수입니다.',
          },
        ]}
      />

      <input ref={fileRef} type="file" className="hidden" onChange={handleUpload} />

      <PromptAdvisor
        title="프롬프트 어드바이저"
        description="업무일지 초안 생성, 미팅/보고 정리, 오늘 기록 요약 요청을 자연어로 정리하고 바로 확인 결과로 이어집니다."
        badge={`Noah 업무 ${user?.role === 'master' ? '오케스트레이터' : user?.role === 'admin' ? '운영 에이전트' : '에이전트'}`}
        suggestions={[
          '오늘 작성한 업무일지를 정리해줘',
          '최근 미팅 업무일지를 중심으로 정리해줘',
          '보고 카테고리 업무일지만 요약해줘',
          '오늘 오전 김대리 업체 미팅 후 후속 견적 요청 사항을 정리해줘',
        ]}
        helperText="업무일지 초안 생성, 미팅/보고 정리, 오늘 기록 요약처럼 업무관리 요청을 빠르게 확인 결과로 넘길 때 적합합니다."
        prompt={prompt}
        onPromptChange={setPrompt}
        promptRef={promptRef}
        placeholder="업무일지 초안이나 업무 요약 요청을 자연어로 입력하세요."
        onFileClick={() => fileRef.current?.click()}
        onFileDrop={handleUpload}
        uploading={uploading}
        attachedFileName={attachedFileName}
        onReset={() => {
          setPrompt('');
          setError('');
          setNotice('');
          setAttachedFileName('');
          setAttachedDocumentContext('');
          setReusedDocument(null);
          if (fileRef.current) fileRef.current.value = '';
        }}
        onSubmit={createProposal}
        submitDisabled={!canCreateJournals || proposalLoading || !(prompt.trim() || attachedDocumentContext.trim())}
        error={error}
        notice={notice}
      />

      {reusedDocument ? (
        <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <p className="font-semibold">문서 재사용 초안이 적용됨</p>
          <p className="mt-1 text-sky-800">{reusedDocument.filename || '이전 문서'} 기반으로 업무일지 초안이 채워졌습니다.</p>
          {reusedDocument.documentId ? (
            <a href={`/documents/${reusedDocument.documentId}`} className="mt-2 inline-flex text-xs font-medium text-sky-700 hover:text-sky-900">
              문서 상세 보기
            </a>
          ) : null}
        </div>
      ) : null}

      {proposal && (
        <PendingReviewSection
          title="확인 및 승인 대기 리스트"
          description="문서 파싱과 자연어 입력 결과를 확인한 뒤 아래 리스트에서 확정하거나 반려합니다."
          hasPending
          badgeLabel="1건 대기 중"
        >
          {proposal && (
            <div className="rounded-3xl border border-sky-200 bg-sky-50/40 px-5 py-5 space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-sky-700">업무일지 확인 항목</p>
                  <h3 className="text-lg font-semibold text-slate-900 mt-1">{proposal.summary || '업무일지 제안'}</h3>
                  <p className="text-sm text-slate-600 mt-1">
                    AI가 자연어 입력을 업무일지 초안으로 정리했습니다. 내용을 검토한 뒤 그대로 확정하거나 반려하세요.
                  </p>
                </div>
                <div className="flex flex-col items-end gap-2 text-right">
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600 border border-slate-200">
                    {proposal.confidence === 'high' ? '해석 신뢰도 높음' : '해석 신뢰도 보통'}
                  </span>
                  <span className={`rounded-full px-3 py-1 text-xs font-semibold border ${proposalChanged(originalProposal, proposal)
                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                    : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
                    {proposalChanged(originalProposal, proposal) ? '수정 있음' : '수정 없음'}
                  </span>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-700">
                  <p><span className="font-semibold text-slate-900">예정 날짜</span> {proposal.date || today()}</p>
                  <p className="mt-1"><span className="font-semibold text-slate-900">카테고리</span> {catLabel(proposal.category || 'general')}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-sm text-slate-700">
                  <p><span className="font-semibold text-slate-900">처리 방식</span> {proposal.confidence === 'high' ? '높은 확신 초안' : '검토 필요 초안'}</p>
                  <p className="mt-1"><span className="font-semibold text-slate-900">설명</span> 초안을 검토한 뒤 확정하거나 반려합니다.</p>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-xs font-semibold text-slate-500">날짜</span>
                  <input type="date" className="input-base" value={proposal.date || ''} onChange={(e) => setProposal((prev) => ({ ...prev, date: e.target.value }))} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-semibold text-slate-500">카테고리</span>
                  <select className="input-base" value={normalizeJournalCategory(proposal.category || 'general')} onChange={(e) => setProposal((prev) => ({ ...prev, category: e.target.value }))}>
                    {CATEGORIES.map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="space-y-1">
                <span className="text-xs font-semibold text-slate-500">내용</span>
                <textarea className="input-base min-h-[144px]" value={proposal.content || ''} onChange={(e) => setProposal((prev) => ({ ...prev, content: e.target.value }))} />
              </label>

              {Array.isArray(proposal.similar_cases) && proposal.similar_cases.length > 0 && (
                <div className="rounded-2xl border border-violet-200 bg-violet-50/70 px-4 py-4">
                  <p className="text-sm font-semibold text-violet-900">유사 확정 사례</p>
                  <p className="text-xs text-violet-700 mt-1">
                    수정 없이 확정된 과거 사례를 참고해 현재 초안을 빠르게 판단할 수 있습니다.
                  </p>
                  <div className="mt-3 space-y-2">
                    {proposal.similar_cases.map((item) => (
                      <div key={item.id} className="rounded-xl border border-violet-100 bg-white/90 px-3 py-3 text-sm text-slate-700">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-medium text-slate-900">{item.summary || `${item.flow_code}/${item.action_code}`}</p>
                          <span className="rounded-full bg-violet-100 px-2 py-1 text-[11px] font-semibold text-violet-700">
                            유사도 {Math.round((item.similarity || 0) * 100)}%
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-slate-600 whitespace-pre-wrap">{item.preview}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                <button type="button" className="btn-secondary flex-1" disabled={proposalActionLoading} onClick={rejectProposal}>
                  제안 반려
                </button>
                <button type="button" className="btn-primary flex-1" disabled={proposalActionLoading || !String(proposal.content || '').trim()} onClick={confirmProposal}>
                  {proposalActionLoading ? '처리 중...' : '이대로 확정'}
                </button>
              </div>
            </div>
          )}
          {!proposal && notice ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-sm text-emerald-900">
              <p className="font-semibold">처리 완료</p>
              <p className="mt-1 text-emerald-800">{notice}</p>
            </div>
          ) : null}
        </PendingReviewSection>
      )}

      <div className="card">
        <OperationsSectionHeader
          title="조회 조건"
          description="날짜와 카테고리, 검색으로 필요한 업무일지만 빠르게 확인합니다."
          className="border-b border-slate-200 pb-3"
          right={(
            <div className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm sm:w-auto sm:justify-end">
              <div><span className="text-slate-500">현재 필터</span> <strong>{[filterDate && '날짜', filterCat && catLabel(filterCat), search && '검색어'].filter(Boolean).join(' · ') || '전체'}</strong></div>
              <div><span className="text-slate-500">오늘 기록</span> <strong>{todayCount}건</strong></div>
            </div>
          )}
        />
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:flex-wrap sm:gap-6">
            <label className="flex w-full items-center justify-between gap-2.5 sm:w-auto sm:justify-start sm:gap-4">
              <span className="w-12 shrink-0 text-xs font-semibold text-slate-500">날짜</span>
              <input
                type="date"
                className="input-base w-[calc(100%-3.5rem)] sm:min-w-[150px] sm:w-auto"
                value={filterDate}
                onChange={e => setFilterDate(e.target.value)}
              />
            </label>
            <label className="flex w-full items-center justify-between gap-2.5 sm:w-auto sm:justify-start sm:gap-4">
              <span className="w-12 shrink-0 text-xs font-semibold text-slate-500">카테고리</span>
              <div className="flex w-[calc(100%-3.5rem)] items-center gap-3 sm:min-w-[150px] sm:w-auto sm:gap-4">
                <select className="input-base min-w-0 flex-1 sm:min-w-[150px]" value={filterCat} onChange={e => setFilterCat(e.target.value)}>
                  <option value="">전체 카테고리</option>
                  {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
                <button
                  type="button"
                  className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition ${
                    showSearchInput || search
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                  aria-label="내용 검색 열기"
                  onClick={() => setShowSearchInput((prev) => !prev)}
                >
                  <Search className="h-4 w-4" />
                </button>
              </div>
            </label>
          </div>
          {canCreateJournals ? (
            <div className="flex justify-end">
              <button className="btn-secondary" onClick={openNew}>
                + 수동 등록
              </button>
            </div>
          ) : null}
        </div>
        <div className="mt-3 flex flex-col gap-2.5 sm:flex-row">
          {(showSearchInput || search) && (
            <form onSubmit={e => { e.preventDefault(); load(); }} className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
              <input
                ref={searchInputRef}
                className="input-base flex-1"
                placeholder="내용 검색"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <div className="flex gap-2 sm:w-auto">
                <button type="submit" className="inline-flex h-10 flex-1 items-center justify-center rounded-2xl bg-slate-900 px-4 text-white transition hover:bg-slate-800 sm:w-10 sm:flex-none sm:rounded-full sm:px-0">
                  <Search className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setSearch('');
                    setShowSearchInput(false);
                    load({ keyword: '' });
                  }}
                >
                  닫기
                </button>
              </div>
            </form>
          )}
          <div className="flex gap-2">
            {(filterDate || filterCat || search) && (
              <button
                className="btn-secondary"
                onClick={() => {
                  setFilterDate('');
                  setFilterCat('');
                  setSearch('');
                  setShowSearchInput(false);
                  load({ date: '', category: '', keyword: '' });
                }}
              >
                초기화
              </button>
            )}
          </div>
        </div>
        <div className="mt-5 border-t border-slate-200 pt-5">
          {loading
            ? <p className="text-center py-10 text-gray-400">로딩 중...</p>
            : <DataTable
                pageSize={10}
                columns={columns}
                data={journals}
                emptyNode={emptyNode}
                actions={row => (
                  <div className="flex flex-wrap gap-2">
                    <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => { setViewItem(row); setViewModal(true); }}>보기</button>
                    {canUpdateJournals && <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => openEdit(row)}>수정</button>}
                    {canDeleteJournals && <button className="btn-danger   text-xs px-3 py-1.5" onClick={() => handleDelete(row.id)}>삭제</button>}
                  </div>
                )}
              />
          }
        </div>
      </div>

      {/* 보기 모달 */}
      <Modal open={viewModal} onClose={() => setViewModal(false)} title="업무일지 상세">
        {viewItem && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-gray-500 text-xs mb-1">날짜</p>
                <p className="font-medium">{viewItem.date?.slice(0, 10) || '-'}</p>
              </div>
              <div>
                <p className="text-gray-500 text-xs mb-1">분류</p>
                <p className="font-medium">{catLabel(viewItem.category)}</p>
              </div>
              <div>
                <p className="text-gray-500 text-xs mb-1">작성자</p>
                <p className="font-medium">{viewItem.employee_name || '-'}</p>
              </div>
            </div>
            <div>
              <p className="text-gray-500 text-xs mb-1">내용</p>
              <p className="text-sm text-gray-800 whitespace-pre-wrap bg-gray-50 rounded-lg p-3 leading-relaxed">
                {viewItem.content}
              </p>
            </div>
            <div className="flex gap-3 pt-2">
              <button className="btn-secondary flex-1" onClick={() => setViewModal(false)}>닫기</button>
              {canUpdateJournals && <button className="btn-primary flex-1" onClick={() => { setViewModal(false); openEdit(viewItem); }}>수정</button>}
            </div>
          </div>
        )}
      </Modal>

      <Modal open={modal} onClose={() => setModal(false)} title={editId ? '업무일지 수정' : '업무일지 등록'}>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">날짜</label>
              <input className="input-base" type="date" value={form.date}
                onChange={e => setForm(p => ({ ...p, date: e.target.value }))} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">카테고리</label>
              <select className="input-base" value={form.category}
                onChange={e => setForm(p => ({ ...p, category: e.target.value }))}>
                {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">내용 *</label>
            <textarea
              className="input-base min-h-[120px] resize-y"
              value={form.content}
              onChange={e => setForm(p => ({ ...p, content: e.target.value }))}
              placeholder="오늘의 업무 내용을 입력하세요"
            />
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button type="button" className="btn-secondary flex-1" onClick={() => setModal(false)}>취소</button>
            <button type="submit"  className="btn-primary flex-1"  disabled={saving}>{saving ? '저장 중...' : '저장'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
