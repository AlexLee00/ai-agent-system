'use client';
import { useState, useEffect, useRef } from 'react';
import { Search } from 'lucide-react';
import { api } from '@/lib/api';
import { getToken, useAuth } from '@/lib/auth-context';
import { canPerformMenuOperation } from '@/lib/menu-access';
import AdminQuickNav from '@/components/AdminQuickNav';
import AdminPageHero from '@/components/AdminPageHero';
import AdminQuickFlowGrid from '@/components/AdminQuickFlowGrid';
import DataTable from '@/components/DataTable';
import Modal from '@/components/Modal';
import PendingReviewSection from '@/components/PendingReviewSection';
import ProposalFlowActions from '@/components/ProposalFlowActions';
import { buildDocumentPromptAppendix, buildDocumentUploadNotice } from '@/lib/document-attachment';

const CATEGORIES = [
  { value: 'general', label: '일반' },
  { value: 'meeting', label: '미팅' },
  { value: 'task',    label: '업무' },
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

export default function JournalsPage() {
  const { user } = useAuth();
  const [journals,   setJournals]   = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [filterDate, setFilterDate] = useState('');
  const [filterCat,  setFilterCat]  = useState('');
  const [search,     setSearch]     = useState('');
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
  const fileRef = useRef(null);

  const refillPrompt = (text) => {
    setPrompt(text);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const load = (kw) => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filterDate) params.set('date', filterDate);
    if (filterCat)  params.set('category', filterCat);
    if (kw ?? search) params.set('keyword', kw ?? search);
    api.get(`/journals?${params}`)
      .then(d => setJournals(d.journals || []))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [filterDate, filterCat]); // eslint-disable-line

  const openNew  = () => { setForm(EMPTY_FORM); setEditId(null); setError(''); setModal(true); };
  const openEdit = (j) => {
    setForm({ date: j.date?.slice(0, 10) || today(), content: j.content || '', category: j.category || 'general' });
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
    if (!prompt.trim()) return;
    setProposalLoading(true);
    setError('');
    setNotice('');
    try {
      const data = await api.post('/journals/proposals', { prompt });
      setProposal(data.proposal || EMPTY_PROPOSAL);
      setOriginalProposal(data.proposal || EMPTY_PROPOSAL);
      setPrompt('');
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
      await api.post(`/journals/proposals/${proposal.feedback_session_id}/confirm`, { proposal });
      setNotice('업무일지를 등록했습니다.');
      setProposal(null);
      setOriginalProposal(null);
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

  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
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
      setPrompt((prev) => `${prev ? `${prev}\n\n` : ''}${appendix}`.trim());
      setNotice(buildDocumentUploadNotice(data.document, file.name));
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const catLabel = (v) => CATEGORIES.find(c => c.value === v)?.label || v;
  const todayDate = today();
  const todayCount = journals.filter(item => (item.date || '').slice(0, 10) === todayDate).length;
  const categorySummary = CATEGORIES
    .filter(item => item.value)
    .map(item => ({
      label: item.label,
      count: journals.filter(row => row.category === item.value).length,
    }))
    .filter(item => item.count > 0)
    .slice(0, 4);

  const columns = [
    { key: 'date',          label: '날짜',   render: v => v?.slice(0, 10) || '-' },
    { key: 'employee_name', label: '작성자' },
    { key: 'category',      label: '분류',   render: v => catLabel(v) },
    { key: 'content',       label: '내용',   render: v => v?.length > 50 ? v.slice(0, 50) + '…' : v },
  ];

  const emptyNode = (
    <div className="text-center py-12">
      <p className="text-4xl mb-3">📝</p>
      <p className="text-gray-500 mb-4">오늘의 업무를 기록해보세요</p>
      <button onClick={openNew} className="btn-primary text-sm">
        + 업무일지 작성하기
      </button>
    </div>
  );

  const canCreateJournals = canPerformMenuOperation(user, 'journals', 'create');
  const canUpdateJournals = canPerformMenuOperation(user, 'journals', 'update');
  const canDeleteJournals = canPerformMenuOperation(user, 'journals', 'delete');
  const quickFlows = [
    {
      title: '오늘 업무일지 점검',
      body: '오늘 작성된 업무일지와 누락된 기록을 다시 점검합니다.',
      onPromptFill: () => refillPrompt('오늘 작성된 업무일지와 누락된 기록을 요약해줘'),
      onSecondary: () => setFilterDate(todayDate),
      secondaryLabel: '오늘 필터 적용',
    },
    {
      title: '미팅/보고 정리',
      body: '미팅, 보고 카테고리 위주로 중요한 기록을 다시 모읍니다.',
      onPromptFill: () => refillPrompt('최근 미팅과 보고 업무일지를 중심으로 정리해줘'),
      onSecondary: () => setFilterCat('meeting'),
      secondaryLabel: '미팅 필터 적용',
    },
  ];

  return (
    <div className="space-y-4">
      {user?.role !== 'member' && <AdminQuickNav />}

      <AdminPageHero
        title="업무 관리"
        description="업무일지 초안, 카테고리 필터, 검색과 상세 열람을 한 화면에서 운영합니다."
        stats={[
          { label: '전체 기록', value: journals.length || 0, caption: '현재 조회 기준' },
          { label: '오늘 기록', value: todayCount || 0, caption: todayDate },
          { label: '분류 수', value: categorySummary.length || 0, caption: '표시된 카테고리' },
        ]}
      />

      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-600">업무일지 운영 작업</p>
        <button className="btn-primary text-sm" onClick={openNew} disabled={!canCreateJournals}>+ 등록</button>
      </div>

      {user?.role !== 'member' && <AdminQuickFlowGrid items={quickFlows} />}

      <div className="card space-y-4">
        <div>
          <p className="text-sm font-semibold text-slate-900">자연어로 업무일지 초안 만들기</p>
          <p className="text-sm text-slate-500 mt-1">입력한 내용을 먼저 확인한 뒤 등록합니다. 수정 내용은 피드백 데이터로 쌓입니다.</p>
        </div>
        <div className="flex flex-col gap-3 lg:flex-row">
          <input ref={fileRef} type="file" className="hidden" onChange={handleUpload} />
          <textarea
            className="input-base min-h-[104px] flex-1"
            placeholder="예: 오늘 오전 김대리 업체 미팅 후 후속 견적 요청 사항을 정리해줘"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          {attachedFileName && (
            <div className="lg:hidden rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 w-fit">
              첨부됨: {attachedFileName}
            </div>
          )}
          <button
            type="button"
            className="btn-primary lg:w-40"
            disabled={!canCreateJournals || proposalLoading || !prompt.trim()}
            onClick={createProposal}
          >
            {proposalLoading ? '초안 생성 중...' : '초안 만들기'}
          </button>
          <button
            type="button"
            className="btn-secondary lg:w-32"
            disabled={!canCreateJournals || uploading}
            onClick={() => fileRef.current?.click()}
          >
            {uploading ? '업로드 중...' : '파일 첨부'}
          </button>
        </div>
        {attachedFileName && (
          <div className="hidden lg:flex">
            <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700">
              첨부됨: {attachedFileName}
            </span>
          </div>
        )}
        {notice && <p className="text-sm text-emerald-600">{notice}</p>}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="card">
          <p className="text-sm font-medium text-slate-500">오늘의 업무 흐름</p>
          <div className="grid gap-3 sm:grid-cols-3 mt-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs text-slate-500">전체 기록</p>
              <p className="text-2xl font-semibold text-slate-900 mt-1">{journals.length}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs text-slate-500">오늘 작성</p>
              <p className="text-2xl font-semibold text-slate-900 mt-1">{todayCount}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-xs text-slate-500">현재 필터</p>
              <p className="text-sm font-semibold text-slate-900 mt-2">
                {[filterDate && '날짜', filterCat && catLabel(filterCat), search && '검색어'].filter(Boolean).join(' · ') || '전체'}
              </p>
            </div>
          </div>
        </div>

        <div className="card">
          <p className="text-sm font-medium text-slate-500">카테고리 분포</p>
          <div className="space-y-2 mt-4">
            {categorySummary.length === 0 ? (
              <p className="text-sm text-slate-400">아직 집계할 업무 분류가 없습니다.</p>
            ) : categorySummary.map((item) => (
              <div key={item.label} className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
                <span className="text-sm font-medium text-slate-700">{item.label}</span>
                <span className="text-sm font-semibold text-slate-900">{item.count}건</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 필터 */}
      <div className="flex flex-wrap gap-2 items-center">
        <input
          type="date"
          className="input-base w-auto"
          value={filterDate}
          onChange={e => setFilterDate(e.target.value)}
        />
        <select className="input-base w-auto" value={filterCat} onChange={e => setFilterCat(e.target.value)}>
          <option value="">전체 카테고리</option>
          {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <form onSubmit={e => { e.preventDefault(); load(); }} className="flex gap-2">
          <input
            className="input-base"
            placeholder="내용 검색"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button type="submit" className="p-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors">
            <Search className="w-4 h-4" />
          </button>
        </form>
        {(filterDate || filterCat || search) && (
          <button
            className="text-xs text-gray-400 hover:text-gray-600"
            onClick={() => { setFilterDate(''); setFilterCat(''); setSearch(''); load(''); }}
          >초기화</button>
        )}
      </div>

      <div className="card">
        {loading
          ? <p className="text-center py-10 text-gray-400">로딩 중...</p>
          : <DataTable
              pageSize={10}
              columns={columns}
              data={journals}
              emptyNode={emptyNode}
              actions={row => (
                <div className="flex gap-2">
                  <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => { setViewItem(row); setViewModal(true); }}>보기</button>
                  {canUpdateJournals && <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => openEdit(row)}>수정</button>}
                  {canDeleteJournals && <button className="btn-danger   text-xs px-3 py-1.5" onClick={() => handleDelete(row.id)}>삭제</button>}
                </div>
              )}
            />
        }
      </div>

      {(proposal || notice) && (
        <PendingReviewSection
          hasPending={Boolean(proposal)}
          description="업무일지 초안을 아래 리스트에서 검토하고 확정하거나 반려합니다."
        >
          {proposal && (
            <div className="rounded-2xl border border-indigo-100 bg-indigo-50/30 px-4 py-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-slate-900">업무일지 제안</p>
                  <p className="text-sm text-slate-500 mt-1">
                    {proposal.summary || '업무일지 제안'} · {proposal.confidence === 'high' ? '높은 확신' : '검토 필요'}
                  </p>
                </div>
                {proposalChanged(originalProposal, proposal) && (
                  <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700">수정됨</span>
                )}
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">날짜</label>
                  <input type="date" className="input-base" value={proposal.date || ''} onChange={(e) => setProposal((prev) => ({ ...prev, date: e.target.value }))} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">카테고리</label>
                  <select className="input-base" value={proposal.category || 'general'} onChange={(e) => setProposal((prev) => ({ ...prev, category: e.target.value }))}>
                    {CATEGORIES.map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">내용</label>
                <textarea className="input-base min-h-[144px]" value={proposal.content || ''} onChange={(e) => setProposal((prev) => ({ ...prev, content: e.target.value }))} />
              </div>
              {Array.isArray(proposal.similar_cases) && proposal.similar_cases.length > 0 && (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm font-semibold text-slate-800">유사 확정 사례</p>
                  <div className="mt-3 space-y-3">
                    {proposal.similar_cases.map((item) => (
                      <div key={item.id} className="rounded-xl bg-white px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-sm font-medium text-slate-900">{item.summary || `${item.flow_code}/${item.action_code}`}</p>
                          <span className="text-xs text-slate-400">{Math.round((item.similarity || 0) * 100)}%</span>
                        </div>
                        <p className="mt-2 text-sm text-slate-600 whitespace-pre-wrap">{item.preview}</p>
                        <button
                          type="button"
                          className="mt-3 rounded-full border border-slate-200 bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-200"
                          onClick={() => refillPrompt(`이 사례를 참고해서 업무일지 초안을 다시 정리해줘\n${item.preview || item.summary || ''}`.trim())}
                        >
                          이 사례로 다시 작성
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap gap-3">
                <ProposalFlowActions
                  onPromptFill={() => refillPrompt(`업무일지 초안을 다시 정리해줘\n날짜: ${proposal.date || ''}\n카테고리: ${proposal.category || ''}\n내용: ${proposal.content || ''}`.trim())}
                  onSecondary={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                />
                <button type="button" className="btn-secondary flex-1" disabled={proposalActionLoading} onClick={rejectProposal}>
                  반려
                </button>
                <button type="button" className="btn-primary flex-1" disabled={proposalActionLoading || !String(proposal.content || '').trim()} onClick={confirmProposal}>
                  {proposalActionLoading ? '처리 중...' : '확정'}
                </button>
              </div>
            </div>
          )}
        </PendingReviewSection>
      )}

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
