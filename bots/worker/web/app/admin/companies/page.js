'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Building2 } from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import DataTable from '@/components/DataTable';
import Modal from '@/components/Modal';

const EMPTY_FORM = { id: '', name: '', owner: '', phone: '', biz_number: '', memo: '' };

export default function AdminCompaniesPage() {
  const { user } = useAuth();
  const router   = useRouter();
  const [companies, setCompanies] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [modal,     setModal]     = useState(false);
  const [form,      setForm]      = useState(EMPTY_FORM);
  const [editId,    setEditId]    = useState(null);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');

  useEffect(() => {
    if (user && user.role !== 'master') router.push('/dashboard');
  }, [user, router]);

  const load = (q = search) => {
    setLoading(true);
    const qs = q ? `?q=${encodeURIComponent(q)}` : '';
    api.get(`/companies${qs}`)
      .then(d => setCompanies(d.companies || []))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const openNew = () => {
    setForm(EMPTY_FORM); setEditId(null); setError(''); setModal(true);
  };
  const openEdit = (c) => {
    setForm({ id: c.id, name: c.name, owner: c.owner || '', phone: c.phone || '', biz_number: c.biz_number || '', memo: c.memo || '' });
    setEditId(c.id); setError(''); setModal(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('업체명은 필수입니다.'); return; }
    if (!editId && !form.id.trim()) { setError('업체 ID는 필수입니다.'); return; }
    setSaving(true); setError('');
    try {
      if (editId) {
        await api.put(`/companies/${editId}`, {
          name: form.name, owner: form.owner, phone: form.phone,
          biz_number: form.biz_number, memo: form.memo,
        });
      } else {
        await api.post('/companies', {
          id: form.id.toLowerCase(), name: form.name,
          owner: form.owner, phone: form.phone,
          biz_number: form.biz_number, memo: form.memo,
        });
      }
      setModal(false); load();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (row) => {
    if (!confirm(`"${row.name}" 업체를 비활성화하시겠습니까?\n(실제 삭제가 아닌 숨김 처리입니다)`)) return;
    await api.delete(`/companies/${row.id}`).catch(e => alert(e.message));
    load();
  };

  const columns = [
    { key: 'id',             label: 'ID',      render: v => <span className="font-mono text-xs">{v}</span> },
    { key: 'name',           label: '업체명' },
    { key: 'owner',          label: '대표자',  render: v => v || '-' },
    { key: 'phone',          label: '연락처',  render: v => v || '-' },
    { key: 'user_count',     label: '사용자',  render: v => `${Number(v)}명` },
    { key: 'employee_count', label: '직원',    render: v => `${Number(v)}명` },
    { key: 'created_at',     label: '등록일',  render: v => v?.slice(0, 10) || '-' },
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

      {/* 검색 */}
      <div className="flex gap-2">
        <input
          className="input-base flex-1 max-w-xs"
          placeholder="업체명 또는 대표자 검색"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && load()}
        />
        <button className="btn-secondary text-sm" onClick={() => load()}>검색</button>
        {search && <button className="btn-secondary text-sm" onClick={() => { setSearch(''); load(''); }}>초기화</button>}
      </div>

      <div className="card">
        {loading ? (
          <p className="text-center py-10 text-gray-400">로딩 중...</p>
        ) : (
          <DataTable
            columns={columns}
            data={companies}
            emptyNode={emptyNode}
            actions={row => (
              <div className="flex gap-2 items-center">
                <Link href={`/admin/companies/${row.id}/menus`}
                  className="text-xs text-indigo-500 hover:text-indigo-700 font-medium px-2 py-1.5 rounded hover:bg-indigo-50 transition-colors">
                  메뉴 설정
                </Link>
                <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => openEdit(row)}>수정</button>
                <button className="btn-danger   text-xs px-3 py-1.5" onClick={() => handleDelete(row)}>삭제</button>
              </div>
            )}
          />
        )}
      </div>

      <Modal open={modal} onClose={() => setModal(false)} title={editId ? '업체 수정' : '업체 등록'}>
        <form onSubmit={handleSave} className="space-y-3">
          {!editId && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">업체 ID *</label>
              <input
                className="input-base font-mono"
                placeholder="영문/숫자/언더스코어 (예: company_a)"
                value={form.id}
                onChange={e => set('id', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
              />
              <p className="text-xs text-gray-400 mt-1">등록 후 변경 불가 (다른 테이블 FK 참조 중)</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">업체명 *</label>
              <input className="input-base w-full" value={form.name}
                onChange={e => set('name', e.target.value)} placeholder="업체명 입력" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">대표자</label>
              <input className="input-base w-full" value={form.owner}
                onChange={e => set('owner', e.target.value)} placeholder="대표자 이름" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">연락처</label>
              <input className="input-base w-full" value={form.phone}
                onChange={e => set('phone', e.target.value)} placeholder="연락처 입력" />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">사업자번호</label>
              <input className="input-base w-full font-mono" value={form.biz_number}
                onChange={e => set('biz_number', e.target.value)} placeholder="000-00-00000" />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">메모</label>
              <textarea className="input-base w-full resize-none" rows={2} value={form.memo}
                onChange={e => set('memo', e.target.value)} placeholder="내부 메모" />
            </div>
          </div>

          {error && <p className="text-red-500 text-sm">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button type="button" className="btn-secondary flex-1" onClick={() => setModal(false)}>취소</button>
            <button type="submit"  className="btn-primary flex-1"  disabled={saving}>
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
