'use client';
import { useState, useEffect } from 'react';
import { Search } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { canPerformMenuOperation } from '@/lib/menu-access';
import AdminQuickNav from '@/components/AdminQuickNav';
import AdminPageHero from '@/components/AdminPageHero';
import AdminQuickFlowGrid from '@/components/AdminQuickFlowGrid';
import DataTable from '@/components/DataTable';
import Modal from '@/components/Modal';
import PendingReviewSection from '@/components/PendingReviewSection';
import ProposalFlowActions from '@/components/ProposalFlowActions';

const EMPTY_FORM = { name: '', position: '', department: '', phone: '', hire_date: '', status: 'active', base_salary: '' };

function proposalChanged(original, proposal) {
  if (!original || !proposal) return false;
  return ['name', 'position', 'department', 'phone', 'hire_date', 'status', 'base_salary'].some((key) => (original[key] || '') !== (proposal[key] || ''));
}

export default function EmployeesPage() {
  const { user } = useAuth();
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading]    = useState(true);
  const [search, setSearch]      = useState('');
  const [modal, setModal]        = useState(false);
  const [form, setForm]          = useState(EMPTY_FORM);
  const [editId, setEditId]      = useState(null);
  const [saving, setSaving]      = useState(false);
  const [error, setError]        = useState('');
  const [prompt, setPrompt] = useState('');
  const [proposal, setProposal] = useState(null);
  const [originalProposal, setOriginalProposal] = useState(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const activeEmployees = employees.filter((item) => item.status === 'active').length;
  const quickFlows = [
    {
      title: '신규 직원 후보 점검',
      body: '최근 등록 요청과 누락 정보를 프롬프트로 바로 이어봅니다.',
      onPromptFill: () => refillPrompt('최근 등록이 필요한 직원 후보를 정리해줘'),
      onSecondary: () => window.scrollTo({ top: 0, behavior: 'smooth' }),
      secondaryLabel: '입력 위치로 이동',
    },
    {
      title: '부서 인력 분포 확인',
      body: '현재 부서별 인력 현황을 확인하고 필요한 보강을 점검합니다.',
      onPromptFill: () => refillPrompt('현재 부서별 인력 분포를 요약해줘'),
      onSecondary: () => setSearch(''),
      secondaryLabel: '필터 초기화',
    },
  ];

  const refillPrompt = (text) => {
    setPrompt(text);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

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

  const createProposal = async () => {
    if (!prompt.trim()) return;
    setProposalLoading(true);
    setError('');
    setNotice('');
    try {
      const data = await api.post('/employees/proposals', { prompt });
      setProposal(data.proposal || null);
      setOriginalProposal(data.proposal || null);
      setPrompt('');
    } catch (err) {
      setError(err.message);
    } finally {
      setProposalLoading(false);
    }
  };

  const handleConfirmProposal = async () => {
    if (!proposal?.feedback_session_id) return;
    setProposalLoading(true);
    setError('');
    try {
      await api.post(`/employees/proposals/${proposal.feedback_session_id}/confirm`, { proposal });
      setNotice('직원 등록 제안을 확정했습니다.');
      setProposal(null);
      setOriginalProposal(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setProposalLoading(false);
    }
  };

  const handleRejectProposal = async () => {
    if (!proposal?.feedback_session_id) return;
    setProposalLoading(true);
    setError('');
    try {
      await api.post(`/employees/proposals/${proposal.feedback_session_id}/reject`, {});
      setNotice('직원 등록 제안을 반려했습니다.');
      setProposal(null);
      setOriginalProposal(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setProposalLoading(false);
    }
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

  const canCreateEmployees = canPerformMenuOperation(user, 'employees', 'create');
  const canUpdateEmployees = canPerformMenuOperation(user, 'employees', 'update');
  const canDeleteEmployees = canPerformMenuOperation(user, 'employees', 'delete');

  return (
    <div className="space-y-4">
      {user?.role !== 'member' && <AdminQuickNav />}

      <AdminPageHero
        title="직원 관리"
        description="직원 등록, 인사 기본정보, 부서/직급 현황을 한 화면에서 운영합니다."
        stats={[
          { label: '전체 직원', value: employees.length || 0, caption: '조회 기준' },
          { label: '재직', value: activeEmployees || 0, caption: 'active 상태' },
          { label: '검색 결과', value: filtered.length || 0, caption: search || '필터 없음' },
        ]}
      />

      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-slate-600">직원 운영 작업</p>
        <button className="btn-primary text-sm" onClick={openNew} disabled={!canCreateEmployees}>+ 직원 추가</button>
      </div>

      {user?.role !== 'member' && <AdminQuickFlowGrid items={quickFlows} />}

      <div className="card space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-500">직원 자연어 등록</p>
            <p className="text-sm text-slate-600 mt-1">
              예: `김민수 대리 영업팀 직원 등록해줘`, `박서연 인사팀 사원 3월 20일 입사로 추가해줘`
            </p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
            확인 결과 창 기반 피드백 수집
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
          {['김민수 대리 영업팀 직원 등록해줘', '박서연 인사팀 사원 3월 20일 입사로 추가해줘', '이도윤 개발팀 팀장 등록해줘'].map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setPrompt(item)}
              className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              {item}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <textarea
            className="input-base min-h-[92px]"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="직원 등록 요청을 자연어로 입력하세요."
          />
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn-primary" onClick={createProposal} disabled={!canCreateEmployees || proposalLoading || !prompt.trim()}>
              {proposalLoading ? '제안 생성 중...' : '직원 제안 만들기'}
            </button>
            <button type="button" className="btn-secondary" onClick={openNew} disabled={!canCreateEmployees}>
              직접 입력 모달 열기
            </button>
          </div>
        </div>

        {error && <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
        {notice && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}
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
                  {canUpdateEmployees && <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => openEdit(row)}>수정</button>}
                  {canDeleteEmployees && <button className="btn-danger   text-xs px-3 py-1.5" onClick={() => handleDelete(row.id)}>삭제</button>}
                </div>
              )}
            />
        }
      </div>

      {(proposal || notice) && (
        <PendingReviewSection
          hasPending={Boolean(proposal)}
          description="직원 등록 제안을 아래 리스트에서 검토하고 확정하거나 반려합니다."
        >
          {proposal && (
            <div className="rounded-2xl border border-sky-200 bg-sky-50/40 px-4 py-4 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-sky-700">직원 등록 제안</p>
                  <h2 className="text-lg font-semibold text-slate-900 mt-1">{proposal.summary}</h2>
                  <p className="text-sm text-slate-600 mt-1">
                    자연어 입력을 직원 등록 제안으로 해석했습니다. 이름과 부서, 직급을 확인한 뒤 확정하세요.
                  </p>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold border ${proposalChanged(originalProposal, proposal)
                  ? 'border-amber-200 bg-amber-50 text-amber-700'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
                  {proposalChanged(originalProposal, proposal) ? '수정 있음' : '수정 없음'}
                </span>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-xs font-semibold text-slate-500">이름</span>
                  <input className="input-base" value={proposal.name || ''} onChange={(e) => setProposal((prev) => ({ ...prev, name: e.target.value, summary: `${e.target.value || '직원'} ${prev.position || '직원'} 등록 제안` }))} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-semibold text-slate-500">직급</span>
                  <input className="input-base" value={proposal.position || ''} onChange={(e) => setProposal((prev) => ({ ...prev, position: e.target.value, summary: `${prev.name || '직원'} ${e.target.value || '직원'} 등록 제안` }))} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-semibold text-slate-500">부서</span>
                  <input className="input-base" value={proposal.department || ''} onChange={(e) => setProposal((prev) => ({ ...prev, department: e.target.value }))} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-semibold text-slate-500">연락처</span>
                  <input className="input-base" value={proposal.phone || ''} onChange={(e) => setProposal((prev) => ({ ...prev, phone: e.target.value }))} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-semibold text-slate-500">입사일</span>
                  <input className="input-base" type="date" value={proposal.hire_date || ''} onChange={(e) => setProposal((prev) => ({ ...prev, hire_date: e.target.value }))} />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-semibold text-slate-500">기본급</span>
                  <input className="input-base" type="number" min="0" step="10000" value={proposal.base_salary || ''} onChange={(e) => setProposal((prev) => ({ ...prev, base_salary: e.target.value }))} />
                </label>
              </div>

              {Array.isArray(proposal.similar_cases) && proposal.similar_cases.length > 0 && (
                <div className="rounded-2xl border border-violet-200 bg-violet-50/70 px-4 py-4">
                  <p className="text-sm font-semibold text-violet-900">유사 확정 사례</p>
                  <div className="mt-3 space-y-2">
                    {proposal.similar_cases.map((item) => (
                      <div key={item.id} className="rounded-xl border border-violet-100 bg-white/90 px-3 py-3 text-sm text-slate-700">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-medium text-slate-900">{item.summary || '유사 직원 등록 사례'}</p>
                          <span className="rounded-full bg-violet-100 px-2 py-1 text-[11px] font-semibold text-violet-700">
                            유사도 {(item.similarity * 100).toFixed(0)}%
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-slate-600 whitespace-pre-wrap">{item.preview}</p>
                        <button
                          type="button"
                          className="mt-3 rounded-full border border-violet-200 bg-violet-100 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-200"
                          onClick={() => refillPrompt(`이 사례를 참고해서 직원 등록 제안을 다시 정리해줘\n${item.preview || item.summary || ''}`.trim())}
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
                  onPromptFill={() => refillPrompt(`직원 등록 제안을 다시 정리해줘\n이름: ${proposal.name || ''}\n부서: ${proposal.department || ''}\n직급: ${proposal.position || ''}`.trim())}
                  onSecondary={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                />
                <button type="button" className="btn-primary" onClick={handleConfirmProposal} disabled={proposalLoading}>
                  {proposalLoading ? '확정 중...' : '이대로 확정'}
                </button>
                <button type="button" className="btn-secondary" onClick={handleRejectProposal} disabled={proposalLoading}>
                  제안 반려
                </button>
                <button type="button" className="btn-secondary" onClick={() => { setProposal(null); setOriginalProposal(null); setError(''); }} disabled={proposalLoading}>
                  닫기
                </button>
              </div>
            </div>
          )}
        </PendingReviewSection>
      )}

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
