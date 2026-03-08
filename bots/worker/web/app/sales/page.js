'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import DataTable from '@/components/DataTable';
import Modal from '@/components/Modal';
import Card from '@/components/Card';
import { SalesBarChart } from '@/components/Chart';

const WEEKDAY = ['일','월','화','수','목','금','토'];
const EMPTY_FORM = { amount: '', category: '', description: '', date: new Date().toISOString().slice(0,10) };

export default function SalesPage() {
  const [sales, setSales]    = useState([]);
  const [summary, setSummary] = useState(null);
  const [chartData, setChartData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal]     = useState(false);
  const [form, setForm]       = useState(EMPTY_FORM);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const [tab, setTab]         = useState('list'); // list | chart

  const load = () => {
    setLoading(true);
    Promise.all([
      api.get('/sales').catch(() => ({ sales: [] })),
      api.get('/sales/summary').catch(() => null),
    ]).then(([list, sum]) => {
      setSales(list.sales || []);
      if (sum) {
        setSummary(sum);
        setChartData((sum.weekly || []).map(r => {
          const d = new Date(r.date);
          return { label: `${d.getMonth()+1}/${d.getDate()}(${WEEKDAY[d.getDay()]})`, total: Number(r.total) };
        }));
      }
    }).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleSave = async (e) => {
    e.preventDefault();
    const amount = parseInt(form.amount, 10);
    if (!amount || amount <= 0) { setError('올바른 금액을 입력하세요'); return; }
    setSaving(true); setError('');
    try {
      await api.post('/sales', { ...form, amount });
      setModal(false); setForm(EMPTY_FORM); load();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id) => {
    if (!confirm('삭제하시겠습니까?')) return;
    await api.delete(`/sales/${id}`).catch(() => {});
    load();
  };

  const columns = [
    { key: 'date',        label: '날짜',     render: v => v?.slice(0,10) || '-' },
    { key: 'amount',      label: '금액',     render: v => `₩${Number(v).toLocaleString()}` },
    { key: 'category',    label: '카테고리' },
    { key: 'description', label: '메모' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">💰 매출 관리</h1>
        <button className="btn-primary text-sm" onClick={() => { setForm(EMPTY_FORM); setError(''); setModal(true); }}>
          + 매출 등록
        </button>
      </div>

      {/* 요약 카드 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <Card title="오늘 매출"  value={`₩${(summary?.today?.total ?? 0).toLocaleString()}`}  icon="📅" color="blue" />
        <Card title="주간 매출"  value={`₩${chartData.reduce((s,r)=>s+r.total,0).toLocaleString()}`} icon="📊" color="green" />
        <Card title="월간 매출"  value={`₩${(summary?.monthly?.reduce?.((s,r)=>s+Number(r.total),0)??0).toLocaleString()}`} icon="📈" color="yellow" />
      </div>

      {/* 탭 */}
      <div className="flex gap-2">
        <button className={`px-4 py-2 rounded-lg text-sm font-medium ${tab==='list'?'bg-primary text-white':'bg-gray-100 text-gray-600'}`} onClick={()=>setTab('list')}>목록</button>
        <button className={`px-4 py-2 rounded-lg text-sm font-medium ${tab==='chart'?'bg-primary text-white':'bg-gray-100 text-gray-600'}`} onClick={()=>setTab('chart')}>차트</button>
      </div>

      {tab === 'list' ? (
        <div className="card">
          {loading
            ? <p className="text-center py-10 text-gray-400">로딩 중...</p>
            : <DataTable
                columns={columns}
                data={sales}
                emptyText="매출 데이터 없음"
                actions={row => (
                  <button className="btn-danger text-xs px-3 py-1.5" onClick={() => handleDelete(row.id)}>삭제</button>
                )}
              />
          }
        </div>
      ) : (
        <div className="card">
          <h2 className="font-semibold text-gray-800 mb-4">주간 매출 추이</h2>
          {chartData.length > 0
            ? <SalesBarChart data={chartData} />
            : <p className="text-center text-gray-400 py-10">데이터 없음</p>
          }
        </div>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title="매출 등록">
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
            <button type="submit"  className="btn-primary flex-1"  disabled={saving}>{saving ? '저장 중...' : '등록'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
