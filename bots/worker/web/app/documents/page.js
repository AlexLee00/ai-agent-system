'use client';
import { useState, useEffect, useRef } from 'react';
import { getToken } from '@/lib/auth-context';
import { api } from '@/lib/api';
import DataTable from '@/components/DataTable';
import Modal from '@/components/Modal';

const CATEGORIES = ['', '계약서', '견적서', '세금계산서', '기타'];
const API_BASE = '/api';

export default function DocumentsPage() {
  const [docs, setDocs]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [catFilter, setCat]   = useState('');
  const [modal, setModal]     = useState(false);
  const [file, setFile]       = useState(null);
  const [category, setCategory] = useState('');
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const fileRef = useRef(null);

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (search)    params.set('keyword', search);
    if (catFilter) params.set('category', catFilter);
    api.get(`/documents?${params}`).then(d => setDocs(d.documents || [])).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [search, catFilter]);

  const openModal = () => {
    setFile(null); setCategory(''); setError('');
    if (fileRef.current) fileRef.current.value = '';
    setModal(true);
  };

  const handleUpload = async (e) => {
    e.preventDefault();
    if (!file) { setError('파일을 선택해주세요.'); return; }
    setSaving(true); setError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      if (category) formData.append('category', category);
      const token = getToken();
      const res = await fetch(`${API_BASE}/documents/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '업로드 실패');
      setModal(false); load();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id) => {
    if (!confirm('문서를 삭제하시겠습니까?')) return;
    try {
      await api.delete(`/documents/${id}`);
      load();
    } catch (e) { alert(e.message); }
  };

  const columns = [
    { key: 'category',   label: '분류' },
    { key: 'filename',   label: '파일명',   render: (v, row) => row.file_path
        ? <a href={row.file_path} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">{v}</a>
        : v },
    { key: 'ai_summary', label: 'AI 요약',  render: v => v ? v.slice(0,40)+'...' : '-' },
    { key: 'created_at', label: '업로드일', render: v => v?.slice(0,10) || '-' },
    { key: 'id', label: '', render: (v) =>
        <button onClick={() => handleDelete(v)} className="text-xs text-red-500 hover:text-red-700">삭제</button> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">📋 문서 관리</h1>
        <button className="btn-primary text-sm" onClick={openModal}>+ 문서 등록</button>
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

      <Modal open={modal} onClose={() => setModal(false)} title="문서 업로드">
        <form onSubmit={handleUpload} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">파일 선택 *</label>
            <input
              ref={fileRef}
              type="file"
              className="block w-full text-sm text-gray-500
                file:mr-3 file:py-2 file:px-4
                file:rounded-lg file:border-0
                file:text-sm file:font-medium
                file:bg-indigo-50 file:text-indigo-700
                hover:file:bg-indigo-100 cursor-pointer"
              onChange={e => setFile(e.target.files?.[0] || null)}
            />
            {file && <p className="text-xs text-gray-400 mt-1">{file.name} ({(file.size/1024).toFixed(1)} KB)</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">분류 (선택 — 미선택 시 자동 분류)</label>
            <select className="input-base" value={category} onChange={e=>setCategory(e.target.value)}>
              {CATEGORIES.map(c => <option key={c} value={c}>{c || '자동 분류'}</option>)}
            </select>
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button type="button" className="btn-secondary flex-1" onClick={() => setModal(false)}>취소</button>
            <button type="submit"  className="btn-primary flex-1"  disabled={saving}>{saving ? '업로드 중...' : '업로드'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
