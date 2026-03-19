'use client';
import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import Modal from '@/components/Modal';

const CATEGORIES = [
  { value: 'general', label: '일일업무' },
  { value: 'meeting', label: '미팅' },
  { value: 'report',  label: '보고' },
  { value: 'other',   label: '기타' },
];

function normalizeJournalCategory(value) {
  return value === 'task' || value === 'daily_work' ? 'general' : value;
}

export default function JournalDetailPage() {
  const { id }                    = useParams();
  const router                    = useRouter();
  const [journal,  setJournal]    = useState(null);
  const [loading,  setLoading]    = useState(true);
  const [modal,    setModal]      = useState(false);
  const [form,     setForm]       = useState({ content: '', category: 'general' });
  const [saving,   setSaving]     = useState(false);
  const [error,    setError]      = useState('');

  const load = () => {
    setLoading(true);
    api.get(`/journals/${id}`)
      .then(d => {
        setJournal(d.journal);
        setForm({ content: d.journal.content, category: normalizeJournalCategory(d.journal.category) });
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [id]); // eslint-disable-line

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.content.trim()) { setError('내용을 입력해주세요.'); return; }
    setSaving(true); setError('');
    try {
      await api.put(`/journals/${id}`, form);
      setModal(false); load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('정말 삭제하시겠습니까?')) return;
    await api.delete(`/journals/${id}`).catch(() => {});
    router.push('/work-journals');
  };

  if (loading) return <p className="text-center py-20 text-gray-400">로딩 중...</p>;
  if (!journal) return (
    <div className="text-center py-20">
      <p className="text-gray-500 mb-4">업무일지를 찾을 수 없습니다.</p>
      <button className="btn-secondary" onClick={() => router.push('/work-journals')}>목록으로</button>
    </div>
  );

  const catLabel = (journal.category === 'general' || journal.category === 'task')
    ? '일일업무'
    : CATEGORIES.find(c => c.value === journal.category)?.label || journal.category;

  return (
    <div className="space-y-4 max-w-2xl">
      {/* 헤더 */}
      <div className="flex items-center gap-3">
        <button onClick={() => router.push('/work-journals')} className="text-gray-500 hover:text-gray-700 text-sm">
          ← 목록
        </button>
        <h1 className="text-xl font-bold text-gray-900 flex-1">📝 업무일지</h1>
        <button className="btn-secondary text-sm" onClick={() => setModal(true)}>수정</button>
        <button className="btn-danger   text-sm" onClick={handleDelete}>삭제</button>
      </div>

      {/* 본문 */}
      <div className="card space-y-4">
        <div className="flex flex-wrap gap-4 text-sm text-gray-500">
          <span>📅 {journal.date?.slice(0, 10)}</span>
          <span>👤 {journal.employee_name}</span>
          <span>🏷️ {catLabel}</span>
          <span>🕐 {new Date(journal.created_at).toLocaleString('ko-KR')}</span>
          {journal.updated_at !== journal.created_at && (
            <span className="text-gray-400 text-xs">(수정됨)</span>
          )}
        </div>
        <hr />
        <p className="whitespace-pre-wrap text-gray-800 leading-relaxed">{journal.content}</p>
      </div>

      {/* 수정 모달 */}
      <Modal open={modal} onClose={() => setModal(false)} title="업무일지 수정">
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">카테고리</label>
            <select className="input-base" value={form.category}
              onChange={e => setForm(p => ({ ...p, category: e.target.value }))}>
              {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">내용 *</label>
            <textarea
              className="input-base min-h-[150px] resize-y"
              value={form.content}
              onChange={e => setForm(p => ({ ...p, content: e.target.value }))}
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
