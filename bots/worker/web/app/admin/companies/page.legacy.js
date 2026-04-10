'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Building2 } from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import AdminQuickNav from '@/components/AdminQuickNav';
import AdminPageHero from '@/components/AdminPageHero';
import AdminQuickFlowGrid from '@/components/AdminQuickFlowGrid';
import DataTable from '@/components/DataTable';
import Modal from '@/components/Modal';

const EMPTY_FORM = { id: '', name: '', owner: '', phone: '', biz_number: '', memo: '' };
const EMPTY_DEACTIVATION_FORM = { companyId: '', companyName: '', reason: '' };

export default function AdminCompaniesPage() {
  const { user } = useAuth();
  const router   = useRouter();
  const [companies, setCompanies] = useState([]);
  const [activities, setActivities] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [search,    setSearch]    = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [modal,     setModal]     = useState(false);
  const [deactivationModal, setDeactivationModal] = useState(false);
  const [form,      setForm]      = useState(EMPTY_FORM);
  const [deactivationForm, setDeactivationForm] = useState(EMPTY_DEACTIVATION_FORM);
  const [editId,    setEditId]    = useState(null);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');
  const quickFlows = [
    {
      title: '업체별 메뉴 점검',
      body: '업체 메뉴 노출 상태를 검토하고 메뉴 설정 화면으로 이어집니다.',
      promptHref: '/dashboard?prompt=' + encodeURIComponent('업체별 메뉴 노출 상태를 요약해줘'),
      route: '/admin/companies',
    },
    {
      title: '운영 이슈 업체 찾기',
      body: '미등록, 미연동, 비활성화된 업체 흐름을 빠르게 점검합니다.',
      promptHref: '/dashboard?prompt=' + encodeURIComponent('운영 점검이 필요한 업체를 요약해줘'),
      route: '/admin/companies',
    },
  ];

  useEffect(() => {
    if (user && user.role !== 'master') router.push('/dashboard');
  }, [user, router]);

  const load = (q = search, status = statusFilter) => {
    setLoading(true);
    const query = new URLSearchParams();
    if (q) query.set('q', q);
    if (status && status !== 'active') query.set('status', status);
    const qs = query.toString() ? `?${query.toString()}` : '';
    api.get(`/companies${qs}`)
      .then(d => setCompanies(d.companies || []))
      .finally(() => setLoading(false));
    api.get('/companies/activity?limit=8')
      .then((d) => setActivities(d.activities || []))
      .catch(() => setActivities([]));
  };

  useEffect(() => { load(search, statusFilter); }, [statusFilter]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const openNew = () => {
    setForm(EMPTY_FORM); setEditId(null); setError(''); setModal(true);
  };
  const openEdit = (c) => {
    setForm({ id: c.id, name: c.name, owner: c.owner || '', phone: c.phone || '', biz_number: c.biz_number || '', memo: c.memo || '' });
    setEditId(c.id); setError(''); setModal(true);
  };
  const openDeactivate = (c) => {
    setDeactivationForm({
      companyId: c.id,
      companyName: c.name,
      reason: c.deactivated_reason || '',
    });
    setError('');
    setDeactivationModal(true);
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

  const handleDelete = async (e) => {
    e.preventDefault();
    if (!deactivationForm.companyId) return;
    if (!confirm(`"${deactivationForm.companyName}" 업체를 비활성화하시겠습니까?\n(실제 삭제가 아닌 비활성화 처리입니다)`)) return;
    const qs = deactivationForm.reason.trim() ? `?reason=${encodeURIComponent(deactivationForm.reason.trim())}` : '';
    await api.delete(`/companies/${deactivationForm.companyId}${qs}`).catch(err => alert(err.message));
    setDeactivationModal(false);
    setDeactivationForm(EMPTY_DEACTIVATION_FORM);
    load();
  };

  const handleRestore = async (row) => {
    if (!confirm(`"${row.name}" 업체를 다시 활성화하시겠습니까?`)) return;
    await api.post(`/companies/${row.id}/restore`).catch(e => alert(e.message));
    load();
  };

  const columns = [
    { key: 'id',             label: 'ID',      render: v => <span className="font-mono text-xs">{v}</span> },
    { key: 'name',           label: '업체명' },
    { key: 'owner',          label: '대표자',  render: v => v || '-' },
    { key: 'phone',          label: '연락처',  render: v => v || '-' },
    { key: 'user_count',     label: '사용자',  render: v => `${Number(v)}명` },
    { key: 'employee_count', label: '직원',    render: v => `${Number(v)}명` },
    {
      key: 'deleted_at',
      label: '상태',
      render: (v) => v
        ? <span className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-700">비활성</span>
        : <span className="rounded-full bg-emerald-100 px-2 py-1 text-[11px] font-semibold text-emerald-700">활성</span>,
    },
    { key: 'deactivated_reason', label: '비활성화 사유', render: (v) => v || '-' },
    { key: 'deactivated_by_name', label: '비활성화한 사용자', render: (v) => v || '-' },
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
      <AdminQuickNav />
      <AdminPageHero
        title="업체 관리"
        badge="MASTER"
        tone="indigo"
        description="업체 등록, 메뉴 노출 정책, 운영 이슈 업체 점검을 한 화면에서 관리합니다."
        stats={[
          { label: statusFilter === 'active' ? '등록 업체' : '조회 업체', value: companies.length || 0, caption: statusFilter === 'active' ? '활성 업체 기준' : statusFilter === 'inactive' ? '비활성 업체 기준' : '활성 + 비활성 기준' },
          { label: '검색어', value: search ? '적용' : '전체', caption: search || '필터 없음' },
        ]}
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-slate-600">
          <Building2 className="h-5 w-5 text-indigo-600" />
          <p className="text-sm font-medium">업체 운영 작업</p>
        </div>
        <button className="btn-primary text-sm" onClick={openNew}>+ 업체 등록</button>
      </div>

      {/* 검색 */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input-base flex-1 max-w-xs"
          placeholder="업체명 또는 대표자 검색"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && load()}
        />
        <select
          className="input-base w-[150px]"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="active">활성 업체</option>
          <option value="inactive">비활성 업체</option>
          <option value="all">전체 업체</option>
        </select>
        <button className="btn-secondary text-sm" onClick={() => load()}>검색</button>
        {search && <button className="btn-secondary text-sm" onClick={() => { setSearch(''); load('', statusFilter); }}>초기화</button>}
      </div>

      <AdminQuickFlowGrid
        items={quickFlows.map((item) => ({
          title: item.title,
          body: item.body,
          onPromptFill: () => router.push(item.promptHref),
          onSecondary: () => router.push(item.route),
        }))}
      />

      <div className="card">
        {loading ? (
          <p className="text-center py-10 text-gray-400">로딩 중...</p>
        ) : (
          <DataTable
              pageSize={10}
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
                {row.deleted_at ? (
                  <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => handleRestore(row)}>복구</button>
                ) : (
                  <button className="btn-danger text-xs px-3 py-1.5" onClick={() => openDeactivate(row)}>비활성화</button>
                )}
              </div>
            )}
          />
        )}
      </div>

      <div className="card">
        <div className="border-b border-slate-200 pb-4">
          <p className="text-sm font-semibold text-slate-900">최근 업체 상태 변경 이력</p>
          <p className="mt-1 text-sm text-slate-500">업체 등록, 수정, 비활성화, 복구 같은 상태 변경을 최근 순으로 보여줍니다.</p>
        </div>
        <div className="mt-4 space-y-3">
          {activities.length ? activities.map((item) => {
            const actionLabel = item.action === 'CREATE'
              ? '등록'
              : item.action === 'UPDATE'
                ? '수정'
                : item.action === 'DELETE'
                  ? '비활성화'
                  : item.action === 'RESTORE'
                    ? '복구'
                    : item.action === 'UPDATE_MENUS'
                      ? '메뉴 변경'
                      : item.action;
            return (
              <div key={item.id} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-white">{actionLabel}</span>
                    <span className="text-sm font-medium text-slate-900">{item.company_name || item.company_id || '업체'}</span>
                  </div>
                  <span className="text-xs text-slate-400">{item.created_at?.slice(0, 16)?.replace('T', ' ') || '-'}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600">
                  <span>처리자: {item.actor_name || '-'}</span>
                  <span>업체 ID: {item.company_id || '-'}</span>
                  {item.action === 'DELETE' && item.deactivated_reason ? <span>사유: {item.deactivated_reason}</span> : null}
                </div>
              </div>
            );
          }) : (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
              최근 업체 상태 변경 이력이 없습니다.
            </div>
          )}
        </div>
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

      <Modal open={deactivationModal} onClose={() => setDeactivationModal(false)} title="업체 비활성화">
        <form onSubmit={handleDelete} className="space-y-4">
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p className="font-semibold">{deactivationForm.companyName || '업체'}</p>
            <p className="mt-1 text-amber-800">비활성화하면 기본 목록에서 숨겨지고, 하위 데이터는 유지됩니다.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">비활성화 사유</label>
            <textarea
              className="input-base w-full resize-none"
              rows={3}
              value={deactivationForm.reason}
              onChange={(e) => setDeactivationForm((prev) => ({ ...prev, reason: e.target.value }))}
              placeholder="운영 종료, 테스트 종료, 통합 이전 등 비활성화 사유를 입력하세요."
            />
          </div>
          <div className="flex gap-3 pt-1">
            <button type="button" className="btn-secondary flex-1" onClick={() => setDeactivationModal(false)}>취소</button>
            <button type="submit" className="btn-danger flex-1">비활성화</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
