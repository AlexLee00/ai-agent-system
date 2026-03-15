'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { canPerformMenuOperation } from '@/lib/menu-access';
import DataTable from '@/components/DataTable';
import Modal from '@/components/Modal';
import Card from '@/components/Card';
import { SalesBarChart } from '@/components/Chart';
import WorkerAIWorkspace from '@/components/WorkerAIWorkspace';

const WEEKDAY = ['일','월','화','수','목','금','토'];
const EMPTY_FORM = { amount: '', category: '', description: '', date: new Date().toISOString().slice(0,10) };

function proposalChanged(original, proposal) {
  if (!original || !proposal) return false;
  return ['amount', 'category', 'description', 'date'].some((key) => String(original[key] || '') !== String(proposal[key] || ''));
}

export default function SalesPage() {
  const { user } = useAuth();
  const [sales, setSales]     = useState([]);
  const [summary, setSummary] = useState(null);
  const [chartData, setChartData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal]     = useState(false);
  const [form, setForm]       = useState(EMPTY_FORM);
  const [editId, setEditId]   = useState(null);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [tab, setTab]         = useState('list');
  const [prompt, setPrompt] = useState('');
  const [proposal, setProposal] = useState(null);
  const [originalProposal, setOriginalProposal] = useState(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [notice, setNotice] = useState('');

  const load = () => {
    setLoading(true);
    Promise.all([
      api.get('/sales?limit=200&from=2000-01-01').catch(() => ({ sales: [] })),
      api.get('/sales/summary').catch(() => null),
    ]).then(([list, sum]) => {
      setSales(list.sales || []);
      if (sum) {
        setSummary(sum);
        setChartData((sum.weekly || []).map(r => {
          const [, m, d] = r.date.split('-').map(Number);
          const dow = new Date(r.date + 'T00:00:00').getDay();
          return { label: `${m}/${d}(${WEEKDAY[dow]})`, total: Number(r.total) };
        }));
      }
    }).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const openModal = () => { setForm(EMPTY_FORM); setEditId(null); setError(''); setModal(true); };
  const openEdit = (row) => {
    setForm({
      amount: String(row.amount || ''),
      category: row.category || '',
      description: row.description || '',
      date: row.date?.slice(0, 10) || new Date().toISOString().slice(0, 10),
    });
    setEditId(row.id);
    setError('');
    setModal(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const amount = parseInt(form.amount, 10);
    if (!amount || amount <= 0) { setError('올바른 금액을 입력하세요'); return; }
    setSaving(true); setError('');
    try {
      if (editId) await api.put(`/sales/${editId}`, { ...form, amount });
      else await api.post('/sales', { ...form, amount });
      setModal(false); setForm(EMPTY_FORM); load();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id) => {
    if (!confirm('삭제하시겠습니까?')) return;
    await api.delete(`/sales/${id}`).catch(() => {});
    load();
  };

  const createProposal = async () => {
    if (!prompt.trim()) return;
    setProposalLoading(true);
    setError('');
    setNotice('');
    try {
      const data = await api.post('/sales/proposals', { prompt });
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
      await api.post(`/sales/proposals/${proposal.feedback_session_id}/confirm`, { proposal });
      setNotice('매출 등록 제안을 확정했습니다.');
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
      await api.post(`/sales/proposals/${proposal.feedback_session_id}/reject`, {});
      setNotice('매출 등록 제안을 반려했습니다.');
      setProposal(null);
      setOriginalProposal(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setProposalLoading(false);
    }
  };

  const columns = [
    { key: 'date',        label: '날짜',     render: v => v?.slice(0,10) || '-' },
    { key: 'amount',      label: '금액',     render: v => `₩${Number(v).toLocaleString()}` },
    { key: 'category',    label: '카테고리' },
    { key: 'description', label: '메모' },
  ];

  const emptyNode = (
    <div className="text-center py-12">
      <p className="text-4xl mb-3">💰</p>
      <p className="text-gray-500 mb-4">오늘의 매출을 입력해보세요</p>
      <button onClick={openModal} className="btn-primary text-sm">
        + 매출 등록하기
      </button>
    </div>
  );

  const canCreateSales = canPerformMenuOperation(user, 'sales', 'create');
  const canUpdateSales = canPerformMenuOperation(user, 'sales', 'update');
  const canDeleteSales = canPerformMenuOperation(user, 'sales', 'delete');

  return (
    <div className="space-y-4">
      <WorkerAIWorkspace
        title="매출 AI 업무대화"
        description="매출 요약, 분석 요청, 보고서 초안을 대화형으로 만들고 업무 큐로 넘길 수 있습니다."
        suggestions={['오늘 매출 요약해줘', '지난주 대비 매출 분석해줘', '이번 달 보고서 초안 만들어줘']}
        allowUpload
      />
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">💰 매출 관리</h1>
        <button className="btn-primary text-sm" onClick={openModal} disabled={!canCreateSales}>
          + 매출 등록
        </button>
      </div>

      <div className="card space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-slate-500">매출 자연어 등록</p>
            <p className="text-sm text-slate-600 mt-1">
              예: `오늘 상품판매 5만원 매출 등록해줘`, `어제 서비스 매출 12만원 기록해줘`
            </p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
            확인 결과 창 기반 피드백 수집
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
          {['오늘 상품판매 5만원 매출 등록해줘', '어제 서비스 매출 12만원 기록해줘', '3월 14일 광고 매출 8만원 추가해줘'].map((item) => (
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
            placeholder="매출 등록 요청을 자연어로 입력하세요."
          />
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn-primary" onClick={createProposal} disabled={!canCreateSales || proposalLoading || !prompt.trim()}>
              {proposalLoading ? '제안 생성 중...' : '매출 제안 만들기'}
            </button>
            <button type="button" className="btn-secondary" onClick={openModal} disabled={!canCreateSales}>
              직접 입력 모달 열기
            </button>
          </div>
        </div>

        {error && <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
        {notice && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}
      </div>

      {proposal && (
        <div className="card space-y-4 border-sky-200 bg-sky-50/40">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-sky-700">확인 결과 창</p>
              <h2 className="text-lg font-semibold text-slate-900 mt-1">{proposal.summary}</h2>
              <p className="text-sm text-slate-600 mt-1">
                자연어 입력을 매출 등록 제안으로 해석했습니다. 금액과 카테고리, 날짜를 확인한 뒤 확정하세요.
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
              <span className="text-xs font-semibold text-slate-500">금액</span>
              <input
                className="input-base"
                type="number"
                min="1"
                value={proposal.amount || ''}
                onChange={(e) => setProposal((prev) => ({
                  ...prev,
                  amount: e.target.value,
                  summary: `${prev.date} ${prev.category || '기타'} 매출 ₩${Number(e.target.value || 0).toLocaleString()} 등록 제안`,
                }))}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-500">카테고리</span>
              <input
                className="input-base"
                value={proposal.category || ''}
                onChange={(e) => setProposal((prev) => ({
                  ...prev,
                  category: e.target.value,
                  summary: `${prev.date} ${e.target.value || '기타'} 매출 ₩${Number(prev.amount || 0).toLocaleString()} 등록 제안`,
                }))}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-slate-500">날짜</span>
              <input
                className="input-base"
                type="date"
                value={proposal.date || ''}
                onChange={(e) => setProposal((prev) => ({
                  ...prev,
                  date: e.target.value,
                  summary: `${e.target.value} ${prev.category || '기타'} 매출 ₩${Number(prev.amount || 0).toLocaleString()} 등록 제안`,
                }))}
              />
            </label>
            <label className="space-y-1 md:col-span-2">
              <span className="text-xs font-semibold text-slate-500">메모</span>
              <input
                className="input-base"
                value={proposal.description || ''}
                onChange={(e) => setProposal((prev) => ({ ...prev, description: e.target.value }))}
              />
            </label>
          </div>

          {Array.isArray(proposal.similar_cases) && proposal.similar_cases.length > 0 && (
            <div className="rounded-2xl border border-violet-200 bg-violet-50/70 px-4 py-4">
              <p className="text-sm font-semibold text-violet-900">유사 확정 사례</p>
              <div className="mt-3 space-y-2">
                {proposal.similar_cases.map((item) => (
                  <div key={item.id} className="rounded-xl border border-violet-100 bg-white/90 px-3 py-3 text-sm text-slate-700">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium text-slate-900">{item.summary || '유사 매출 등록 사례'}</p>
                      <span className="rounded-full bg-violet-100 px-2 py-1 text-[11px] font-semibold text-violet-700">
                        유사도 {(item.similarity * 100).toFixed(0)}%
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-slate-600 whitespace-pre-wrap">{item.preview}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn-primary" onClick={handleConfirmProposal} disabled={proposalLoading}>
              {proposalLoading ? '확정 중...' : '이대로 확정'}
            </button>
            <button type="button" className="btn-secondary" onClick={handleRejectProposal} disabled={proposalLoading}>
              제안 반려
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setProposal(null);
                setOriginalProposal(null);
                setError('');
              }}
              disabled={proposalLoading}
            >
              닫기
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="card">
          <p className="text-sm font-medium text-slate-500">매출 운영 요약</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-4">
            <Card title="오늘 매출" value={`₩${(summary?.today?.total ?? 0).toLocaleString()}`} icon="📅" color="blue" />
            <Card title="주간 매출" value={`₩${chartData.reduce((s,r)=>s+r.total,0).toLocaleString()}`} icon="📊" color="green" />
            <Card title="월간 매출" value={`₩${(summary?.monthly?.reduce?.((s,r)=>s+Number(r.total),0)??0).toLocaleString()}`} icon="📈" color="yellow" />
          </div>
        </div>

        <div className="card">
          <p className="text-sm font-medium text-slate-500">보기 전환</p>
          <div className="flex gap-2 mt-4">
            <button className={`px-4 py-2 rounded-2xl text-sm font-medium ${tab==='list'?'bg-slate-900 text-white':'bg-slate-100 text-slate-600'}`} onClick={()=>setTab('list')}>목록</button>
            <button className={`px-4 py-2 rounded-2xl text-sm font-medium ${tab==='chart'?'bg-slate-900 text-white':'bg-slate-100 text-slate-600'}`} onClick={()=>setTab('chart')}>차트</button>
          </div>
          <p className="text-sm text-slate-500 mt-4">
            등록과 분석을 같은 화면에서 빠르게 전환할 수 있습니다.
          </p>
        </div>
      </div>

      {tab === 'list' ? (
        <div className="card">
          {loading
            ? <p className="text-center py-10 text-gray-400">로딩 중...</p>
            : <DataTable
                columns={columns}
                data={sales}
                pageSize={10}
                emptyNode={emptyNode}
                actions={row => (
                  <>
                    {canUpdateSales && <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => openEdit(row)}>수정</button>}
                    {canDeleteSales && <button className="btn-danger text-xs px-3 py-1.5" onClick={() => handleDelete(row.id)}>삭제</button>}
                  </>
                )}
              />
          }
        </div>
      ) : (
        <div className="card">
          <h2 className="font-semibold text-gray-800 mb-4">주간 매출 추이</h2>
          {chartData.length > 0 ? (
            <SalesBarChart data={chartData} />
          ) : (
            <div className="text-center py-10">
              <p className="text-4xl mb-3">📊</p>
              <p className="text-gray-500 text-sm mb-4">매출 데이터가 없습니다</p>
              <button onClick={openModal} className="btn-primary text-sm" disabled={!canCreateSales}>
                + 매출 등록하기
              </button>
            </div>
          )}
        </div>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title={editId ? '매출 수정' : '매출 등록'}>
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">금액 (원) *</label>
            <input className="input-base" type="number" min="1" value={form.amount} onChange={e=>setForm(p=>({...p,amount:e.target.value}))} placeholder="50000" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">카테고리</label>
            <input className="input-base" value={form.category} onChange={e=>setForm(p=>({...p,category:e.target.value}))} placeholder="상품판매, 서비스 등" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">메모</label>
            <input className="input-base" value={form.description} onChange={e=>setForm(p=>({...p,description:e.target.value}))} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">날짜</label>
            <input className="input-base" type="date" value={form.date} onChange={e=>setForm(p=>({...p,date:e.target.value}))} />
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button type="button" className="btn-secondary flex-1" onClick={() => setModal(false)}>취소</button>
            <button type="submit"  className="btn-primary flex-1"  disabled={saving}>{saving ? '저장 중...' : editId ? '수정' : '등록'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
