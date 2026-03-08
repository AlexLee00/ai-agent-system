'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import DataTable from '@/components/DataTable';
import Modal from '@/components/Modal';

const CATEGORIES = ['', '계약서', '견적서', '세금계산서', '기타'];

export default function DocumentsPage() {
  const [docs, setDocs]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [catFilter, setCat]   = useState('');
  const [modal, setModal]     = useState(false);
  const [form, setForm]       = useState({ filename: '', category: '' });
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search)    params.set('keyword', search);
    if (catFilter) params.set('category', catFilter);
    api.get(`/documents?${params}`).then(d => setDocs(d.documents || [])).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [search, catFilter]);

  const handleUpload = async (e) => {
    e.preventDefault();
    if (!form.filename.trim()) { setError('파일명은 필수입니다.'); return; }
    setSaving(true); setError('');
    try {
      await api.post('/documents/upload', form);
      setModal(false); setForm({ filename: '', category: '' }); load();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  const columns = [
    { key: 'category',  label: '분류' },
    { key: 'filename',  label: '파일명' },
    { key: 'ai_summary', label: 'AI 요약', render: v => v ? v.slice(0,40)+'...' : '-' },
    { key: 'created_at', label: '업로드일', render: v => v?.slice(0,10) || '-' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">📋 문서 관리</h1>
        <button className="btn-primary text-sm" onClick={() => { setError(''); setModal(true); }}>+ 문서 등록</button>
      </div>

      {/* 필터 */}
      <div className="flex flex-col sm:flex-row gap-3">
        <input className="input-base sm:max-w-xs" placeholder="키워드 검색" value={search} onChange={e=>setSearch(e.target.value)} />
        <select className="input-base sm:max-w-40" value={catFilter} onChange={e=>setCat(e.target.value)}>
          {CATEGORIES.map(c => <option key={c} value={c}>{c || '전체 분류'}</option>)}
        </select>
      </div>

      <div className="card">
        {loading
          ? <p className="text-center py-10 text-gray-400">로딩 중...</p>
          : <DataTable columns={columns} data={docs} emptyText="문서 없음" />
        }
      </div>

      <Modal open={modal} onClose={() => setModal(false)} title="문서 등록">
        <form onSubmit={handleUpload} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">파일명 *</label>
            <input className="input-base" value={form.filename} onChange={e=>setForm(p=>({...p,filename:e.target.value}))} placeholder="계약서_2026_03.pdf" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">분류 (선택 — 미선택 시 AI 자동 분류)</label>
            <select className="input-base" value={form.category} onChange={e=>setForm(p=>({...p,category:e.target.value}))}>
              {CATEGORIES.map(c => <option key={c} value={c}>{c || '자동 분류'}</option>)}
            </select>
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button type="button" className="btn-secondary flex-1" onClick={() => setModal(false)}>취소</button>
            <button type="submit"  className="btn-primary flex-1"  disabled={saving}>{saving ? '저장 중...' : '등록'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
