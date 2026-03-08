'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Building2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import DataTable from '@/components/DataTable';
import Modal from '@/components/Modal';

const EMPTY_FORM = { id: '', name: '' };

export default function AdminCompaniesPage() {
  const { user } = useAuth();
  const router   = useRouter();
  const [companies, setCompanies] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [modal,     setModal]     = useState(false);
  const [form,      setForm]      = useState(EMPTY_FORM);
  const [editId,    setEditId]    = useState(null);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');

  // 마스터 전용 페이지 — 권한 없으면 리다이렉트
  useEffect(() => {
    if (user && user.role !== 'master') router.push('/dashboard');
  }, [user, router]);

  const load = () => {
    setLoading(true);
    api.get('/companies').then(d => setCompanies(d.companies || [])).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const openNew  = () => { setForm(EMPTY_FORM); setEditId(null); setError(''); setModal(true); };
  const openEdit = (c) => { setForm({ id: c.id, name: c.name }); setEditId(c.id); setError(''); setModal(true); };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('업체명은 필수입니다.'); return; }
    if (!editId && !form.id.trim()) { setError('업체 ID는 필수입니다.'); return; }
    setSaving(true); setError('');
    try {
      if (editId) {
        await api.put(`/companies/${editId}`, { name: form.name });
      } else {
        await api.post('/companies', { id: form.id.toLowerCase(), name: form.name });
      }
      setModal(false); load();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id) => {
    if (!confirm(`"${id}" 업체를 삭제하시겠습니까?\n연결된 모든 데이터에 영향이 있을 수 있습니다.`)) return;
    await api.delete(`/companies/${id}`).catch(() => {});
    load();
  };

  const columns = [
    { key: 'id',         label: 'ID' },
    { key: 'name',       label: '업체명' },
    { key: 'created_at', label: '등록일', render: v => v?.slice(0,10) || '-' },
  ];

  const emptyNode = (
    <div className="text-center py-12">
      <p className="text-4xl mb-3">🏢</p>
      <p className="text-gray-500 mb-4">등록된 업체가 없습니다</p>
      <button onClick={openNew} className="btn-primary text-sm">+ 업체 등록하기</button>
    </div>
  );

  if (user?.role !== 'master') return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Building2 className="w-6 h-6 text-indigo-600" />
          <h1 className="text-xl font-bold text-gray-900">업체 관리</h1>
          <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">MASTER</span>
        </div>
        <button className="btn-primary text-sm" onClick={openNew}>+ 업체 등록</button>
      </div>

      <div className="card">
        {loading
          ? <p className="text-center py-10 text-gray-400">로딩 중...</p>
          : <DataTable
              columns={columns}
              data={companies}
              emptyNode={emptyNode}
              actions={row => (
                <div className="flex gap-2">
                  <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => openEdit(row)}>수정</button>
                  <button className="btn-danger   text-xs px-3 py-1.5" onClick={() => handleDelete(row.id)}>삭제</button>
                </div>
              )}
            />
        }
      </div>

      <Modal open={modal} onClose={() => setModal(false)} title={editId ? '업체 수정' : '업체 등록'}>
        <form onSubmit={handleSave} className="space-y-4">
          {!editId && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">업체 ID *</label>
              <input
                className="input-base font-mono"
                placeholder="영문/숫자/언더스코어 (예: company_a)"
                value={form.id}
                onChange={e => setForm(p => ({ ...p, id: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g,'') }))}
              />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">업체명 *</label>
            <input
              className="input-base"
              placeholder="업체명 입력"
              value={form.name}
              onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
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
