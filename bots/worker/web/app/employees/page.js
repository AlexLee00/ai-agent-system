'use client';
import { useState, useEffect } from 'react';
import { Search } from 'lucide-react';
import { api } from '@/lib/api';
import DataTable from '@/components/DataTable';
import Modal from '@/components/Modal';

const EMPTY_FORM = { name: '', position: '', department: '', phone: '', hire_date: '', status: 'active', base_salary: '' };

export default function EmployeesPage() {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading]    = useState(true);
  const [search, setSearch]      = useState('');
  const [modal, setModal]        = useState(false);
  const [form, setForm]          = useState(EMPTY_FORM);
  const [editId, setEditId]      = useState(null);
  const [saving, setSaving]      = useState(false);
  const [error, setError]        = useState('');

  const load = () => {
    setLoading(true);
    api.get('/employees').then(d => setEmployees(d.employees || [])).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const filtered = employees.filter(e =>
    !search || e.name.includes(search) || (e.department || '').includes(search) || (e.position || '').includes(search)
  );

  const openNew = () => { setForm(EMPTY_FORM); setEditId(null); setError(''); setModal(true); };
  const openEdit = (emp) => {
    setForm({
      name: emp.name || '', position: emp.position || '', department: emp.department || '',
      phone: emp.phone || '', hire_date: emp.hire_date?.slice(0,10) || '', status: emp.status || 'active',
      base_salary: emp.base_salary ? String(emp.base_salary) : '',
    });
    setEditId(emp.id); setError(''); setModal(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('이름은 필수입니다.'); return; }
    setSaving(true); setError('');
    try {
      if (editId) await api.put(`/employees/${editId}`, form);
      else        await api.post('/employees', form);
      setModal(false); load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('정말 삭제하시겠습니까?')) return;
    await api.delete(`/employees/${id}`).catch(() => {});
    load();
  };

  const columns = [
    { key: 'name',        label: '이름' },
    { key: 'position',    label: '직급' },
    { key: 'department',  label: '부서' },
    { key: 'phone',       label: '연락처' },
    { key: 'base_salary', label: '기본급', render: v => v ? `₩${Number(v).toLocaleString()}` : '-' },
    { key: 'hire_date',   label: '입사일', render: v => v?.slice(0,10) || '-' },
    { key: 'status',      label: '상태',   render: v => v === 'active' ? '✅ 재직' : '⬛ 퇴직' },
  ];

  const emptyNode = (
    <div className="text-center py-12">
      <p className="text-4xl mb-3">👥</p>
      <p className="text-gray-500 mb-4">아직 등록된 직원이 없습니다</p>
      <button onClick={openNew} className="btn-primary text-sm">
        + 첫 직원 등록하기
      </button>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">👥 직원 관리</h1>
        <button className="btn-primary text-sm" onClick={openNew}>+ 직원 추가</button>
      </div>

      {/* 검색 */}
      <div className="flex gap-2 max-w-xs">
        <input
          className="input-base flex-1"
          placeholder="이름/부서/직급 검색"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <button className="p-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors">
          <Search className="w-4 h-4" />
        </button>
      </div>

      <div className="card">
        {loading
          ? <p className="text-center py-10 text-gray-400">로딩 중...</p>
          : <DataTable
              pageSize={10}
              columns={columns}
              data={filtered}
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

      <Modal open={modal} onClose={() => setModal(false)} title={editId ? '직원 수정' : '직원 추가'}>
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">이름 *</label>
            <input className="input-base" value={form.name} onChange={e => setForm(p=>({...p,name:e.target.value}))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">직급</label>
              <input className="input-base" value={form.position} onChange={e => setForm(p=>({...p,position:e.target.value}))} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">부서</label>
              <input className="input-base" value={form.department} onChange={e => setForm(p=>({...p,department:e.target.value}))} />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">연락처</label>
            <input className="input-base" type="tel" value={form.phone} onChange={e => setForm(p=>({...p,phone:e.target.value}))} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">입사일</label>
            <input className="input-base" type="date" value={form.hire_date} onChange={e => setForm(p=>({...p,hire_date:e.target.value}))} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">기본급 (원)</label>
            <input className="input-base font-mono" type="number" min="0" step="10000" value={form.base_salary}
              onChange={e => setForm(p=>({...p,base_salary:e.target.value}))} placeholder="3000000" />
          </div>
          {editId && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">상태</label>
              <select className="input-base" value={form.status} onChange={e => setForm(p=>({...p,status:e.target.value}))}>
                <option value="active">재직</option>
                <option value="resigned">퇴직</option>
              </select>
            </div>
          )}
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
