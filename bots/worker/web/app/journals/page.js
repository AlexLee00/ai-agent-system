'use client';
import { useState, useEffect } from 'react';
import { Search } from 'lucide-react';
import { api } from '@/lib/api';
import DataTable from '@/components/DataTable';
import Modal from '@/components/Modal';
import WorkerAIWorkspace from '@/components/WorkerAIWorkspace';

const CATEGORIES = [
  { value: 'general', label: '일반' },
  { value: 'meeting', label: '미팅' },
  { value: 'task',    label: '업무' },
  { value: 'report',  label: '보고' },
  { value: 'other',   label: '기타' },
];

const today = () => new Date().toISOString().slice(0, 10);
const EMPTY_FORM = { date: today(), content: '', category: 'general' };

export default function JournalsPage() {
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

  return (
    <div className="space-y-4">
      <WorkerAIWorkspace
        title="업무 AI 업무대화"
        description="업무 기록, 보고 요청, 문서 업로드를 하나의 작업 공간에서 처리합니다."
        suggestions={['오늘 해야 할 일 정리해줘', '지난 업무일지 요약해줘', '프로젝트 보고 초안 만들어줘']}
        allowUpload
      />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">📝 업무 관리</h1>
        <button className="btn-primary text-sm" onClick={openNew}>+ 등록</button>
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
                  <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => openEdit(row)}>수정</button>
                  <button className="btn-danger   text-xs px-3 py-1.5" onClick={() => handleDelete(row.id)}>삭제</button>
                </div>
              )}
            />
        }
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
              <button className="btn-primary flex-1" onClick={() => { setViewModal(false); openEdit(viewItem); }}>수정</button>
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
