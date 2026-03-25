'use client';
import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { canPerformMenuOperation } from '@/lib/menu-access';
import AdminQuickNav from '@/components/AdminQuickNav';
import AdminPageHero from '@/components/AdminPageHero';
import DataTable from '@/components/DataTable';
import Modal from '@/components/Modal';
import Card from '@/components/Card';
import { SalesBarChart } from '@/components/Chart';
import PendingReviewSection from '@/components/PendingReviewSection';
import PromptAdvisor from '@/components/PromptAdvisor';
import OperationsSectionHeader from '@/components/OperationsSectionHeader';
import { OperationsLoadAlert, OperationsLoadingPlaceholder } from '@/components/OperationsLoadState';
import { buildDocumentPromptAppendix, buildDocumentUploadNotice, mergePromptWithDocumentContext } from '@/lib/document-attachment';
import { consumeDocumentReuseDraft } from '@/lib/document-reuse-draft';
import useAutoResizeTextarea from '@/lib/useAutoResizeTextarea';
import { useOperationsLoader } from '@/lib/use-operations-loader';

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
const EMPTY_SALE_FORM = { amount: '', category: '', description: '', date: new Date().toISOString().slice(0, 10) };
const EMPTY_EXPENSE_FORM = { amount: '', category: '', item_name: '', note: '', date: new Date().toISOString().slice(0, 10), expense_type: 'variable' };
const FINANCE_TABS = [
  { key: 'sales', label: '매출' },
  { key: 'expenses', label: '매입' },
  { key: 'profit', label: '손익' },
];

function proposalChanged(original, proposal) {
  if (!original || !proposal) return false;
  return ['amount', 'category', 'description', 'date', 'item_name', 'note', 'expense_type'].some((key) => String(original[key] || '') !== String(proposal[key] || ''));
}

function normalizeChartData(rows = []) {
  return rows.map((r) => {
    const [, m, d] = r.date.split('-').map(Number);
    const dow = new Date(`${r.date}T00:00:00`).getDay();
    return { label: `${m}/${d}(${WEEKDAY[dow]})`, total: Number(r.total) };
  });
}

export default function SalesPage() {
  const { user, loading: authLoading } = useAuth();
  const [financeTab, setFinanceTab] = useState('sales');
  const [salesView, setSalesView] = useState('list');
  const [sales, setSales] = useState([]);
  const [summary, setSummary] = useState(null);
  const [chartData, setChartData] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [expenseSummary, setExpenseSummary] = useState(null);
  const [modal, setModal] = useState(false);
  const [expenseModal, setExpenseModal] = useState(false);
  const [form, setForm] = useState(EMPTY_SALE_FORM);
  const [expenseForm, setExpenseForm] = useState(EMPTY_EXPENSE_FORM);
  const [editId, setEditId] = useState(null);
  const [expenseEditId, setExpenseEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [expenseSaving, setExpenseSaving] = useState(false);
  const [error, setError] = useState('');
  const { loading, loadError, setLoadError, runLoad } = useOperationsLoader(true);
  const [prompt, setPrompt] = useState('');
  const [proposalType, setProposalType] = useState('sales');
  const [proposal, setProposal] = useState(null);
  const [originalProposal, setOriginalProposal] = useState(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [uploading, setUploading] = useState(false);
  const [attachedFileName, setAttachedFileName] = useState('');
  const [attachedDocumentContext, setAttachedDocumentContext] = useState('');
  const [reusedDocument, setReusedDocument] = useState(null);
  const fileRef = useRef(null);
  const expenseImportRef = useRef(null);
  const promptRef = useRef(null);
  useAutoResizeTextarea(promptRef, prompt);

  const canCreateSales = canPerformMenuOperation(user, 'sales', 'create');
  const canUpdateSales = canPerformMenuOperation(user, 'sales', 'update');
  const canDeleteSales = canPerformMenuOperation(user, 'sales', 'delete');

  const currentMonthProfit = Number(summary?.currentMonth?.total ?? 0) - Number(expenseSummary?.currentMonth?.total ?? 0);

  const advisorTitle = financeTab === 'expenses' ? '프롬프트 어드바이저' : '프롬프트 어드바이저';
  const advisorDescription = financeTab === 'expenses'
    ? '매입 등록, 고정지출 반영, 지출 누락 점검 요청을 자연어로 정리하고 바로 제안 검토로 이어집니다.'
    : financeTab === 'profit'
      ? '손익 요약은 현재 읽기 전용 분석 영역입니다. 매출 또는 매입 탭에서 등록과 수정 흐름을 진행한 뒤 손익으로 확인합니다.'
      : '매출 등록, 누락 점검, 주간 흐름 비교 요청을 자연어로 정리하고 바로 제안 검토로 이어집니다.';
  const advisorBadge = financeTab === 'expenses'
    ? `Noah 매입 ${user?.role === 'master' ? '오케스트레이터' : user?.role === 'admin' ? '운영 에이전트' : '에이전트'}`
    : `Noah 매출 ${user?.role === 'master' ? '오케스트레이터' : user?.role === 'admin' ? '운영 에이전트' : '에이전트'}`;
  const advisorSuggestions = financeTab === 'expenses'
    ? [
        '오늘 세무기장 88000원 지출 등록해줘',
        '1월 27일 가습기 94000원 매입 등록해줘',
        '이번 주 고정지출 누락 점검해줘',
      ]
    : financeTab === 'profit'
      ? [
          '이번 달 손익 구조를 검토해줘',
          '고정지출 비중을 점검해줘',
          '최근 3개월 매출 대비 매입 추세를 보고 싶어',
        ]
      : [
          '오늘 상품판매 5만원 매출 등록해줘',
          '어제 서비스 매출 12만원 기록해줘',
          '3월 14일 광고 매출 8만원 추가해줘',
        ];
  const advisorPlaceholder = financeTab === 'expenses'
    ? '매입 등록 요청이나 지출 점검 요청을 자연어로 입력하세요.'
    : financeTab === 'profit'
      ? '손익 탭은 현재 읽기 전용입니다. 매출 또는 매입 탭에서 입력을 진행하세요.'
      : '매출 등록 요청이나 흐름 점검 요청을 자연어로 입력하세요.';
  const advisorHelper = financeTab === 'expenses'
    ? '매입 등록, 고정지출 반영, 지출 누락 점검처럼 매입 운영 요청을 빠르게 결과로 넘길 때 적합합니다.'
    : financeTab === 'profit'
      ? '손익은 매출과 매입 데이터를 기반으로 자동 집계됩니다.'
      : '매출 등록, 매출 누락 점검, 주간 매출 비교처럼 매출 운영 요청을 빠르게 확인 결과로 넘길 때 적합합니다.';

  const clearPromptState = () => {
    setPrompt('');
    setError('');
    setNotice('');
    setAttachedFileName('');
    setAttachedDocumentContext('');
    setReusedDocument(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const load = async () => {
    return runLoad(async () => {
      const [salesList, salesSummary, expenseList, expenseSummaryData] = await Promise.allSettled([
        api.get('/sales?limit=1000&from=2000-01-01'),
        api.get('/sales/summary'),
        api.get('/expenses?limit=1000&from=2000-01-01'),
        api.get('/expenses/summary'),
      ]);

      if (salesList.status === 'fulfilled') {
        setSales(salesList.value.sales || []);
      } else {
        setSales([]);
      }

      if (salesSummary.status === 'fulfilled') {
        setSummary(salesSummary.value);
        setChartData(normalizeChartData(salesSummary.value?.weekly || []));
      } else {
        setSummary(null);
        setChartData([]);
      }

      if (expenseList.status === 'fulfilled') {
        setExpenses(expenseList.value.expenses || []);
      } else {
        setExpenses([]);
      }

      if (expenseSummaryData.status === 'fulfilled') {
        setExpenseSummary(expenseSummaryData.value);
      } else {
        setExpenseSummary(null);
      }

      const failures = [salesList, salesSummary, expenseList, expenseSummaryData].filter((result) => result.status === 'rejected');
      if (failures.length > 0) {
        setLoadError(failures[0].reason?.message || '매출 데이터를 불러오지 못했습니다.');
      }
    });
  };

  useEffect(() => {
    load();
  }, [authLoading, user?.id]);
  useEffect(() => {
    const reusedDraft = consumeDocumentReuseDraft('sales');
    if (reusedDraft?.draft) {
      setPrompt(reusedDraft.draft);
      setReusedDocument(reusedDraft);
    }
  }, []);

  const openModal = () => {
    setForm(EMPTY_SALE_FORM);
    setEditId(null);
    setError('');
    setModal(true);
  };

  const openExpenseModal = () => {
    setExpenseForm(EMPTY_EXPENSE_FORM);
    setExpenseEditId(null);
    setError('');
    setExpenseModal(true);
  };

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

  const openExpenseEdit = (row) => {
    setExpenseForm({
      amount: String(row.amount || ''),
      category: row.category || '',
      item_name: row.item_name || '',
      note: row.note || '',
      date: row.date?.slice(0, 10) || new Date().toISOString().slice(0, 10),
      expense_type: row.expense_type || 'variable',
    });
    setExpenseEditId(row.id);
    setError('');
    setExpenseModal(true);
  };

  const handleSave = async (e) => {
    e.preventDefault();
    const amount = parseInt(form.amount, 10);
    if (!amount || amount <= 0) { setError('올바른 금액을 입력하세요'); return; }
    setSaving(true);
    setError('');
    try {
      if (editId) await api.put(`/sales/${editId}`, { ...form, amount });
      else await api.post('/sales', { ...form, amount });
      setModal(false);
      setForm(EMPTY_SALE_FORM);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleExpenseSave = async (e) => {
    e.preventDefault();
    const amount = parseInt(expenseForm.amount, 10);
    if (!amount || amount <= 0) { setError('올바른 매입 금액을 입력하세요'); return; }
    setExpenseSaving(true);
    setError('');
    try {
      const payload = {
        ...expenseForm,
        amount,
        quantity: null,
        unit_price: null,
      };
      if (expenseEditId) await api.put(`/expenses/${expenseEditId}`, payload);
      else await api.post('/expenses', payload);
      setExpenseModal(false);
      setExpenseForm(EMPTY_EXPENSE_FORM);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setExpenseSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('삭제하시겠습니까?')) return;
    await api.delete(`/sales/${id}`).catch(() => {});
    load();
  };

  const handleExpenseDelete = async (id) => {
    if (!confirm('삭제하시겠습니까?')) return;
    await api.delete(`/expenses/${id}`).catch(() => {});
    load();
  };

  const createProposal = async () => {
    if (!(prompt.trim() || attachedDocumentContext.trim())) return;
    if (financeTab === 'profit') return;
    setProposalLoading(true);
    setError('');
    setNotice('');
    try {
      const endpoint = financeTab === 'expenses' ? '/expenses/proposals' : '/sales/proposals';
      const data = await api.post(endpoint, {
        prompt: mergePromptWithDocumentContext(prompt, attachedDocumentContext),
      });
      setProposalType(financeTab === 'expenses' ? 'expense' : 'sales');
      setProposal(data.proposal || null);
      setOriginalProposal(data.proposal || null);
      setPrompt('');
      setAttachedFileName('');
      setAttachedDocumentContext('');
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
      const isExpense = proposalType === 'expense';
      const endpoint = isExpense
        ? `/expenses/proposals/${proposal.feedback_session_id}/confirm`
        : `/sales/proposals/${proposal.feedback_session_id}/confirm`;
      const data = await api.post(endpoint, {
        proposal,
        reuse_event_id: reusedDocument?.reuseEventId || null,
      });
      setNotice(isExpense ? '매입 등록 제안을 확정했습니다.' : '매출 등록 제안을 확정했습니다.');
      setProposal(null);
      setOriginalProposal(null);
      setReusedDocument(null);
      if (isExpense && data?.expense) setFinanceTab('expenses');
      if (!isExpense && data?.sale) setFinanceTab('sales');
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
      const endpoint = proposalType === 'expense'
        ? `/expenses/proposals/${proposal.feedback_session_id}/reject`
        : `/sales/proposals/${proposal.feedback_session_id}/reject`;
      await api.post(endpoint, {});
      setNotice(proposalType === 'expense' ? '매입 등록 제안을 반려했습니다.' : '매출 등록 제안을 반려했습니다.');
      setProposal(null);
      setOriginalProposal(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setProposalLoading(false);
    }
  };

  const handleUpload = async (input) => {
    const file = input instanceof File ? input : input?.target?.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    setUploading(true);
    setError('');
    try {
      const token = getToken();
      const res = await fetch('/api/documents/upload', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '파일 업로드 실패');
      const filename = data.document?.filename || file.name;
      const appendix = buildDocumentPromptAppendix(data.document, file.name);
      setAttachedFileName(filename);
      setAttachedDocumentContext(appendix);
      setNotice(buildDocumentUploadNotice(data.document, file.name));
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleExpenseImport = async (input) => {
    const file = input instanceof File ? input : input?.target?.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    setUploading(true);
    setError('');
    try {
      const token = getToken();
      const res = await fetch('/api/expenses/import/excel', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '매입 엑셀 import 실패');
      setFinanceTab('expenses');
      setNotice(data.notice || '매입 엑셀 import를 완료했습니다.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (expenseImportRef.current) expenseImportRef.current.value = '';
    }
  };

  const salesColumns = [
    { key: 'date', label: '날짜', render: (v) => v?.slice(0, 10) || '-' },
    { key: 'amount', label: '금액', render: (v) => `₩${Number(v).toLocaleString()}` },
    { key: 'category', label: '카테고리' },
    { key: 'description', label: '메모' },
  ];

  const expenseColumns = [
    { key: 'date', label: '날짜', render: (v) => v?.slice(0, 10) || '-' },
    { key: 'amount', label: '금액', render: (v) => `₩${Number(v).toLocaleString()}` },
    { key: 'category', label: '항목' },
    { key: 'item_name', label: '품목', render: (v) => v || '-' },
    { key: 'expense_type', label: '구분', render: (v) => v === 'fixed' ? '고정지출' : '변동지출' },
    { key: 'note', label: '비고', render: (v) => v || '-' },
  ];

  const salesEmptyNode = (
    <div className="text-center py-12">
      <p className="text-4xl mb-3">💰</p>
      <p className="text-gray-500 mb-4">오늘의 매출을 입력해보세요</p>
      <button onClick={openModal} className="btn-primary text-sm">
        + 매출 등록하기
      </button>
    </div>
  );

  const expenseEmptyNode = (
    <div className="text-center py-12">
      <p className="text-4xl mb-3">🧾</p>
      <p className="text-gray-500 mb-4">매입 원장을 등록해 손익 구조를 연결해보세요</p>
      <button onClick={openExpenseModal} className="btn-primary text-sm">
        + 매입 등록하기
      </button>
    </div>
  );

  const activeSummaryTitle = financeTab === 'expenses' ? '매입 운영 요약' : financeTab === 'profit' ? '손익 운영 요약' : '매출 운영 요약';
  const activeSummaryDescription = financeTab === 'expenses'
    ? '매입 원장을 요약 카드로 먼저 보고, 같은 카드 안에서 리스트를 확인하며 수동 등록으로 이어집니다.'
    : financeTab === 'profit'
      ? '매출과 매입 집계를 같은 카드에서 비교해 이번 달 손익 구조를 빠르게 파악합니다.'
      : '매출 흐름을 요약 카드로 먼저 보고, 같은 카드 안에서 목록과 차트를 전환해 이어서 확인합니다.';
  const activeTabIndex = FINANCE_TABS.findIndex((tab) => tab.key === financeTab);

  return (
    <div className="space-y-4">
      {user?.role !== 'member' && <AdminQuickNav />}

      <AdminPageHero
        title="매출 관리"
        description="매출, 매입, 손익을 한 화면에서 이어서 확인하고 운영 입력까지 연결합니다."
        stats={[
          { label: '누적 매출', value: `₩${Number(summary?.currentYear?.total ?? 0).toLocaleString()}`, caption: '당해연도 누적 기준' },
          { label: '누적 매입', value: `₩${Number(expenseSummary?.currentYear?.total ?? 0).toLocaleString()}`, caption: '당해연도 누적 기준' },
          { label: '이번 달 손익', value: `₩${currentMonthProfit.toLocaleString()}`, caption: '매출 - 매입' },
        ]}
      />

      <OperationsLoadAlert error={loadError} onRetry={load} />

      {financeTab !== 'profit' ? (
        <div>
          <input ref={fileRef} type="file" className="hidden" onChange={handleUpload} />
          <input ref={expenseImportRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleExpenseImport} />
          <PromptAdvisor
            title={advisorTitle}
            description={advisorDescription}
            badge={advisorBadge}
            suggestions={advisorSuggestions}
            helperText={advisorHelper}
            prompt={prompt}
            onPromptChange={setPrompt}
            promptRef={promptRef}
            placeholder={advisorPlaceholder}
            onFileClick={() => fileRef.current?.click()}
            onFileDrop={handleUpload}
            uploading={uploading}
            attachedFileName={attachedFileName}
            onReset={clearPromptState}
            onSubmit={createProposal}
            submitDisabled={!canCreateSales || proposalLoading || !(prompt.trim() || attachedDocumentContext.trim())}
            error={error}
            notice={notice}
          />
          {reusedDocument ? (
            <div className="mt-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
              <p className="font-semibold">문서 재사용 초안이 적용됨</p>
              <p className="mt-1 text-sky-800">{reusedDocument.filename || '이전 문서'} 기반으로 {financeTab === 'expenses' ? '매입' : '매출'} 등록 초안이 채워졌습니다.</p>
              {reusedDocument.documentId ? (
                <a href={`/documents/${reusedDocument.documentId}`} className="mt-2 inline-flex text-xs font-medium text-sky-700 hover:text-sky-900">
                  문서 상세 보기
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="card">
          <input ref={fileRef} type="file" className="hidden" onChange={handleUpload} />
          <input ref={expenseImportRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleExpenseImport} />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium text-slate-500">손익 브리핑</p>
              <p className="mt-1 text-sm leading-relaxed text-slate-600 break-keep">
                손익 탭은 읽기 전용 분석 영역입니다. 매출과 매입 누적을 같은 기준으로 비교해 이번 달 운영 상태를 빠르게 확인합니다.
              </p>
            </div>
            <span className="max-w-full self-start break-keep rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
              Finance 읽기 전용
            </span>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-3xl border border-slate-200 bg-white px-4 py-4">
              <p className="text-sm font-medium text-slate-500 break-keep">이번 달 손익</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">₩{currentMonthProfit.toLocaleString()}</p>
              <div className="mt-3 space-y-3">
                <p className="text-xs leading-relaxed text-slate-400 break-keep">이번 달 매출 - 매입</p>
                <p className="text-sm leading-relaxed text-slate-500 break-keep">
                  현재 월 기준 순손익을 빠르게 확인합니다.
                </p>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white px-4 py-4">
              <p className="text-sm font-medium text-slate-500 break-keep">월간 매출</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">₩{Number(summary?.currentMonth?.total ?? 0).toLocaleString()}</p>
              <div className="mt-3 space-y-3">
                <p className="text-xs leading-relaxed text-slate-400 break-keep">당월 누적 기준</p>
                <p className="text-sm leading-relaxed text-slate-500 break-keep">
                  손익 해석의 기준이 되는 이번 달 매출 합계입니다.
                </p>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white px-4 py-4">
              <p className="text-sm font-medium text-slate-500 break-keep">월간 매입</p>
              <p className="mt-2 text-2xl font-semibold text-slate-900">₩{Number(expenseSummary?.currentMonth?.total ?? 0).toLocaleString()}</p>
              <div className="mt-3 space-y-3">
                <p className="text-xs leading-relaxed text-slate-400 break-keep">당월 누적 기준</p>
                <p className="text-sm leading-relaxed text-slate-500 break-keep">
                  고정비와 변동비를 포함한 이번 달 매입 합계입니다.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-3xl border border-slate-200 bg-white p-1.5 shadow-sm">
        <div className="relative grid grid-cols-3 gap-1">
          <div
            className="absolute inset-y-0 left-0 w-1/3 rounded-[22px] bg-slate-900 shadow-sm transition-transform duration-300 ease-out"
            style={{ transform: `translateX(${Math.max(activeTabIndex, 0) * 100}%)` }}
          />
          {FINANCE_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setFinanceTab(tab.key)}
              className={`relative z-10 min-h-[52px] rounded-[22px] px-4 py-3 text-sm font-semibold transition-colors ${
                financeTab === tab.key ? 'text-white' : 'text-slate-500'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <OperationsSectionHeader
          className="border-b border-slate-200 pb-4"
          title={activeSummaryTitle}
          description={activeSummaryDescription}
          right={(
            <div className="flex flex-wrap items-center justify-end gap-2">
              {financeTab === 'sales' ? (
                <>
                  <button
                    className={`px-4 py-2 rounded-2xl text-sm font-medium ${salesView === 'list' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'}`}
                    onClick={() => setSalesView('list')}
                  >
                    목록
                  </button>
                  <button
                    className={`px-4 py-2 rounded-2xl text-sm font-medium ${salesView === 'chart' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'}`}
                    onClick={() => setSalesView('chart')}
                  >
                    차트
                  </button>
                  <button className="btn-secondary text-sm" onClick={openModal} disabled={!canCreateSales}>
                    + 매출 등록
                  </button>
                </>
              ) : financeTab === 'expenses' ? (
                <>
                  <button className="btn-secondary text-sm" onClick={() => expenseImportRef.current?.click()} disabled={!canCreateSales || uploading}>
                    {uploading ? '가져오는 중...' : '엑셀 가져오기'}
                  </button>
                  <button className="btn-secondary text-sm" onClick={openExpenseModal} disabled={!canCreateSales}>
                    + 매입 등록
                  </button>
                </>
              ) : null}
            </div>
          )}
        />

        {financeTab === 'sales' ? (
          <>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Card title="오늘 매출" value={`₩${Number(summary?.today?.total ?? 0).toLocaleString()}`} icon="📅" color="blue" />
              <Card title="주간 매출" value={`₩${chartData.reduce((s, r) => s + r.total, 0).toLocaleString()}`} icon="📊" color="green" />
              <Card title="월간 매출" value={`₩${Number(summary?.currentMonth?.total ?? 0).toLocaleString()}`} icon="📈" color="yellow" />
            </div>

            <div className="mt-5 border-t border-slate-200 pt-5">
              {salesView === 'list' ? (
                loading ? (
                  <OperationsLoadingPlaceholder />
                ) : (
                  <DataTable
                    columns={salesColumns}
                    data={sales}
                    pageSize={10}
                    emptyNode={salesEmptyNode}
                    actions={(row) => (
                      <>
                        {canUpdateSales && <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => openEdit(row)}>수정</button>}
                        {canDeleteSales && <button className="btn-danger text-xs px-3 py-1.5" onClick={() => handleDelete(row.id)}>삭제</button>}
                      </>
                    )}
                  />
                )
              ) : chartData.length > 0 ? (
                <SalesBarChart data={chartData} />
              ) : (
                <div className="py-10 text-center">
                  <p className="mb-3 text-4xl">📊</p>
                  <p className="mb-4 text-sm text-gray-500">매출 데이터가 없습니다</p>
                  <button onClick={openModal} className="btn-primary text-sm" disabled={!canCreateSales}>
                    + 매출 등록하기
                  </button>
                </div>
              )}
            </div>
          </>
        ) : financeTab === 'expenses' ? (
          <>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Card title="오늘 매입" value={`₩${Number(expenseSummary?.today?.total ?? 0).toLocaleString()}`} icon="📅" color="red" />
              <Card title="주간 매입" value={`₩${Number((expenseSummary?.weekly || []).reduce((sum, row) => sum + Number(row.total || 0), 0)).toLocaleString()}`} icon="🧾" color="yellow" />
              <Card title="월간 매입" value={`₩${Number(expenseSummary?.currentMonth?.total ?? 0).toLocaleString()}`} icon="📉" color="green" />
            </div>

            <div className="mt-5 border-t border-slate-200 pt-5">
              {loading ? (
                <OperationsLoadingPlaceholder />
              ) : (
                <DataTable
                  columns={expenseColumns}
                  data={expenses}
                  pageSize={10}
                  emptyNode={expenseEmptyNode}
                  actions={(row) => (
                    <>
                      {canUpdateSales && <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => openExpenseEdit(row)}>수정</button>}
                      {canDeleteSales && <button className="btn-danger text-xs px-3 py-1.5" onClick={() => handleExpenseDelete(row.id)}>삭제</button>}
                    </>
                  )}
                />
              )}
            </div>
          </>
        ) : (
          <>
            <div className="mt-5 border-t border-slate-200 pt-5">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                  <p className="text-sm font-semibold text-slate-900">이번 달 손익 구조</p>
                  <p className="mt-2 text-sm text-slate-600">매출과 매입 누적을 같은 기준으로 비교해 현재 월 운영 상태를 빠르게 읽습니다.</p>
                  <div className="mt-4 space-y-2 text-sm text-slate-700">
                    <div className="flex items-center justify-between">
                      <span>월간 매출</span>
                      <span className="font-semibold">₩{Number(summary?.currentMonth?.total ?? 0).toLocaleString()}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span>월간 매입</span>
                      <span className="font-semibold">₩{Number(expenseSummary?.currentMonth?.total ?? 0).toLocaleString()}</span>
                    </div>
                    <div className="flex items-center justify-between border-t border-slate-200 pt-2">
                      <span>월간 손익</span>
                      <span className={`font-semibold ${currentMonthProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>₩{currentMonthProfit.toLocaleString()}</span>
                    </div>
                  </div>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                  <p className="text-sm font-semibold text-slate-900">월별 비교</p>
                  <div className="mt-3 space-y-2">
                    {(summary?.monthly || []).slice(-6).map((row) => {
                      const monthExpense = Number((expenseSummary?.monthly || []).find((item) => item.month === row.month)?.total ?? 0);
                      const monthSales = Number(row.total || 0);
                      const monthProfit = monthSales - monthExpense;
                      return (
                        <div key={row.month} className="grid grid-cols-[90px_1fr] gap-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-3 text-sm">
                          <p className="font-medium text-slate-700">{row.month}</p>
                          <div className="space-y-1 text-slate-600">
                            <div className="flex items-center justify-between"><span>매출</span><span>₩{monthSales.toLocaleString()}</span></div>
                            <div className="flex items-center justify-between"><span>매입</span><span>₩{monthExpense.toLocaleString()}</span></div>
                            <div className="flex items-center justify-between font-medium"><span>손익</span><span className={monthProfit >= 0 ? 'text-emerald-700' : 'text-rose-700'}>₩{monthProfit.toLocaleString()}</span></div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {proposal && (
        <PendingReviewSection
          hasPending
          description={proposalType === 'expense'
            ? '문서 파싱과 자연어 입력 결과를 확인한 뒤 아래 리스트에서 매입으로 확정하거나 반려합니다.'
            : '문서 파싱과 자연어 입력 결과를 확인한 뒤 아래 리스트에서 매출로 확정하거나 반려합니다.'}
        >
          <div className="rounded-2xl border border-sky-200 bg-sky-50/40 px-4 py-4 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-sky-700">{proposalType === 'expense' ? '매입 등록 제안' : '매출 등록 제안'}</p>
                <h2 className="text-lg font-semibold text-slate-900 mt-1">{proposal.summary}</h2>
                <p className="text-sm text-slate-600 mt-1">
                  {proposalType === 'expense'
                    ? '자연어 입력을 매입 등록 제안으로 해석했습니다. 금액과 항목, 날짜를 확인한 뒤 확정하세요.'
                    : '자연어 입력을 매출 등록 제안으로 해석했습니다. 금액과 카테고리, 날짜를 확인한 뒤 확정하세요.'}
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
                <input className="input-base" type="number" min="1" value={proposal.amount || ''} onChange={(e) => setProposal((prev) => ({ ...prev, amount: e.target.value }))} />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold text-slate-500">{proposalType === 'expense' ? '항목' : '카테고리'}</span>
                <input className="input-base" value={proposal.category || ''} onChange={(e) => setProposal((prev) => ({ ...prev, category: e.target.value }))} />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-semibold text-slate-500">날짜</span>
                <input className="input-base" type="date" value={proposal.date || ''} onChange={(e) => setProposal((prev) => ({ ...prev, date: e.target.value }))} />
              </label>
              {proposalType === 'expense' ? (
                <label className="space-y-1">
                  <span className="text-xs font-semibold text-slate-500">지출 구분</span>
                  <select className="input-base" value={proposal.expense_type || 'variable'} onChange={(e) => setProposal((prev) => ({ ...prev, expense_type: e.target.value }))}>
                    <option value="variable">변동지출</option>
                    <option value="fixed">고정지출</option>
                  </select>
                </label>
              ) : null}
              {proposalType === 'expense' ? (
                <label className="space-y-1 md:col-span-2">
                  <span className="text-xs font-semibold text-slate-500">품목</span>
                  <input className="input-base" value={proposal.item_name || ''} onChange={(e) => setProposal((prev) => ({ ...prev, item_name: e.target.value }))} />
                </label>
              ) : (
                <label className="space-y-1 md:col-span-2">
                  <span className="text-xs font-semibold text-slate-500">메모</span>
                  <input className="input-base" value={proposal.description || ''} onChange={(e) => setProposal((prev) => ({ ...prev, description: e.target.value }))} />
                </label>
              )}
              {proposalType === 'expense' ? (
                <label className="space-y-1 md:col-span-2">
                  <span className="text-xs font-semibold text-slate-500">비고</span>
                  <input className="input-base" value={proposal.note || ''} onChange={(e) => setProposal((prev) => ({ ...prev, note: e.target.value }))} />
                </label>
              ) : null}
            </div>

            {Array.isArray(proposal.similar_cases) && proposal.similar_cases.length > 0 && (
              <div className="rounded-2xl border border-violet-200 bg-violet-50/70 px-4 py-4">
                <p className="text-sm font-semibold text-violet-900">유사 확정 사례</p>
                <div className="mt-3 space-y-2">
                  {proposal.similar_cases.map((item) => (
                    <div key={item.id} className="rounded-xl border border-violet-100 bg-white/90 px-3 py-3 text-sm text-slate-700">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium text-slate-900">{item.summary || '유사 등록 사례'}</p>
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
            </div>
          </div>
        </PendingReviewSection>
      )}

      <Modal open={modal} onClose={() => setModal(false)} title={editId ? '매출 수정' : '매출 등록'}>
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">금액 (원) *</label>
            <input className="input-base" type="number" min="1" value={form.amount} onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value }))} placeholder="50000" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">카테고리</label>
            <input className="input-base" value={form.category} onChange={(e) => setForm((p) => ({ ...p, category: e.target.value }))} placeholder="상품판매, 서비스 등" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">메모</label>
            <input className="input-base" value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">날짜</label>
            <input className="input-base" type="date" value={form.date} onChange={(e) => setForm((p) => ({ ...p, date: e.target.value }))} />
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button type="button" className="btn-secondary flex-1" onClick={() => setModal(false)}>취소</button>
            <button type="submit" className="btn-primary flex-1" disabled={saving}>{saving ? '저장 중...' : editId ? '수정' : '등록'}</button>
          </div>
        </form>
      </Modal>

      <Modal open={expenseModal} onClose={() => setExpenseModal(false)} title={expenseEditId ? '매입 수정' : '매입 등록'}>
        <form onSubmit={handleExpenseSave} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">금액 (원) *</label>
            <input className="input-base" type="number" min="1" value={expenseForm.amount} onChange={(e) => setExpenseForm((p) => ({ ...p, amount: e.target.value }))} placeholder="88000" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">항목</label>
            <input className="input-base" value={expenseForm.category} onChange={(e) => setExpenseForm((p) => ({ ...p, category: e.target.value }))} placeholder="월세, 세무기장, 기타 등" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">품목</label>
            <input className="input-base" value={expenseForm.item_name} onChange={(e) => setExpenseForm((p) => ({ ...p, item_name: e.target.value }))} placeholder="1월 프린터 렌탈료 등" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">비고</label>
            <input className="input-base" value={expenseForm.note} onChange={(e) => setExpenseForm((p) => ({ ...p, note: e.target.value }))} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">날짜</label>
            <input className="input-base" type="date" value={expenseForm.date} onChange={(e) => setExpenseForm((p) => ({ ...p, date: e.target.value }))} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">지출 구분</label>
            <select className="input-base" value={expenseForm.expense_type} onChange={(e) => setExpenseForm((p) => ({ ...p, expense_type: e.target.value }))}>
              <option value="variable">변동지출</option>
              <option value="fixed">고정지출</option>
            </select>
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button type="button" className="btn-secondary flex-1" onClick={() => setExpenseModal(false)}>취소</button>
            <button type="submit" className="btn-primary flex-1" disabled={expenseSaving}>{expenseSaving ? '저장 중...' : expenseEditId ? '수정' : '등록'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
