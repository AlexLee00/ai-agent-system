'use client';

import { useEffect, useMemo, useState } from 'react';
import { Activity, BrainCircuit, Cpu, RefreshCcw } from 'lucide-react';
import AdminQuickNav from '@/components/AdminQuickNav';
import AdminPageHero from '@/components/AdminPageHero';
import { api } from '@/lib/api';

const llmModeLabels = {
  off: 'OFF',
  assist: '보조',
  full: 'FULL',
};

export default function WorkerMonitoringPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [payload, setPayload] = useState(null);
  const [selectedProvider, setSelectedProvider] = useState('groq');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.get('/admin/monitoring/llm-api');
      setPayload(data);
      setSelectedProvider(data.selected_api || 'groq');
    } catch (err) {
      setError(err.message || '워커 모니터링 정보를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const selectedOption = useMemo(
    () => (payload?.options || []).find((option) => option.key === selectedProvider),
    [payload?.options, selectedProvider],
  );

  async function handleSaveProvider() {
    setSaving(true);
    setNotice('');
    setError('');
    try {
      const data = await api.put('/admin/monitoring/llm-api', { provider: selectedProvider });
      setPayload(data);
      setSelectedProvider(data.selected_api || selectedProvider);
      setNotice(data.message || '워커 웹 기본 분석 API를 저장했습니다.');
    } catch (err) {
      setError(err.message || 'LLM API 설정을 저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <AdminQuickNav />

      <AdminPageHero
        title="워커 모니터링"
        badge="ADMIN"
        tone="slate"
        description="워커 웹에서 현재 어떤 LLM API 경로를 쓰는지 확인하고, 관리자 분석 경로의 기본 API를 안전하게 선택합니다."
        stats={[
          { label: '기본 API', value: payload?.selected_api_label || '-', caption: '관리자 AI 분석 기준' },
          { label: 'LLM 모드', value: llmModeLabels[payload?.ai_policy?.llm_mode] || '-', caption: '현재 로그인 사용자 기준' },
          { label: '설정 가능 API', value: payload?.options?.length || 0, caption: '연동 상태 포함' },
        ]}
      />

      {error && <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
      {notice && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
        <div className="space-y-6">
          <div className="card space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-900">LLM API 선택</p>
                <p className="mt-1 text-sm text-slate-500">관리자용 AI 질문과 매출 예측 보조 분석에 사용할 기본 API를 선택합니다.</p>
              </div>
              <button
                type="button"
                className="btn-secondary text-sm"
                onClick={load}
                disabled={loading}
              >
                <RefreshCcw className="mr-2 h-4 w-4" />
                새로고침
              </button>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <label className="block text-xs font-semibold text-slate-500">기본 LLM API</label>
              <select
                className="input-base mt-2"
                value={selectedProvider}
                onChange={(event) => setSelectedProvider(event.target.value)}
                disabled={loading || saving}
              >
                {(payload?.options || []).map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label} {option.configured ? '' : '(미연동)'}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs text-slate-500">
                {selectedOption?.description || '사용할 LLM API를 선택하면 워커 웹 관리자 분석 경로의 기본 공급자를 바꿉니다.'}
              </p>
              <div className="mt-4 flex items-center justify-between gap-3">
                <div className="text-xs text-slate-500">
                  현재 선택 모델: <span className="font-mono text-slate-700">{selectedOption?.primaryModel || '-'}</span>
                </div>
                <button
                  type="button"
                  className="btn-primary text-sm"
                  onClick={handleSaveProvider}
                  disabled={loading || saving || !selectedProvider}
                >
                  {saving ? '저장 중...' : '기본 API 저장'}
                </button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {(payload?.options || []).map((option) => (
                <div key={option.key} className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-900">{option.label}</p>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${option.configured ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                      {option.configured ? '연동됨' : '미연동'}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">{option.description}</p>
                  <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-700">{option.primaryModel}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="card space-y-4">
            <div className="flex items-center gap-2">
              <BrainCircuit className="h-5 w-5 text-indigo-600" />
              <div>
                <p className="text-sm font-semibold text-slate-900">현재 적용 정책</p>
                <p className="text-xs text-slate-500">로그인 사용자 기준 AI 정책과 이번 페이지의 기본 API 선택은 별도 축으로 관리됩니다.</p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-xs font-medium text-slate-500">UI 모드</p>
                <p className="mt-2 text-sm font-semibold text-slate-900">{payload?.ai_policy?.ui_mode || '-'}</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-xs font-medium text-slate-500">LLM 모드</p>
                <p className="mt-2 text-sm font-semibold text-slate-900">{llmModeLabels[payload?.ai_policy?.llm_mode] || '-'}</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-xs font-medium text-slate-500">확인 정책</p>
                <p className="mt-2 text-sm font-semibold text-slate-900">{payload?.ai_policy?.confirmation_mode || '-'}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="card space-y-4">
          <div className="flex items-center gap-2">
            <Cpu className="h-5 w-5 text-slate-900" />
            <div>
              <p className="text-sm font-semibold text-slate-900">현재 LLM API 적용 내용</p>
              <p className="text-xs text-slate-500">워커 내부에서 실제로 어떤 API 경로가 적용되는지 운영 설명을 함께 제공합니다.</p>
            </div>
          </div>

          {loading ? (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-8 text-sm text-slate-500">
              워커 모니터링 정보를 불러오는 중입니다...
            </div>
          ) : (
            <div className="space-y-3">
              {(payload?.application_summary || []).map((item) => (
                <div key={`${item.area}-${item.route}`} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{item.area}</p>
                      <p className="mt-1 text-xs font-medium text-slate-500">{item.route}</p>
                    </div>
                    <Activity className="h-4 w-4 text-slate-400" />
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl bg-white px-3 py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">API</p>
                      <p className="mt-1 text-sm font-semibold text-slate-900">{item.currentApi}</p>
                    </div>
                    <div className="rounded-xl bg-white px-3 py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">모델/체인</p>
                      <p className="mt-1 break-all font-mono text-xs text-slate-700">{item.currentModel}</p>
                    </div>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-slate-600">{item.description}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
