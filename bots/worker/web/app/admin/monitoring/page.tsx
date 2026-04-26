// @ts-nocheck
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

const adviceTone = {
  hold: 'bg-emerald-100 text-emerald-700',
  compare: 'bg-amber-100 text-amber-700',
  switch_candidate: 'bg-rose-100 text-rose-700',
  observe: 'bg-slate-200 text-slate-700',
};

export default function WorkerMonitoringPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [speedRunning, setSpeedRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [payload, setPayload] = useState(null);
  const [selectorEdits, setSelectorEdits] = useState({});
  const [selectorSavingKey, setSelectorSavingKey] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.get('/admin/monitoring/llm-api');
      setPayload(data);
    } catch (err) {
      setError(err.message || '워커 모니터링 정보를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);
  const usageSummary = payload?.usage_summary || {
    periodHours: 24,
    totalCalls: 0,
    successCalls: 0,
    failedCalls: 0,
    successRatePct: 0,
    totalCostUsd: 0,
    avgLatencyMs: null,
    latestCallAt: null,
    byProvider: [],
    byRoute: [],
  };
  const changeHistory = payload?.change_history || [];
  const changeImpact = payload?.change_impact || [];
  const globalSelectorSummary = payload?.global_selector_summary || null;
  const selectorEditors = payload?.selector_editors || {};
  const speedTestConsole = payload?.speed_test_console || {
    targets: [],
    latest: null,
    review: null,
    results: [],
    summary: { targetCount: 0, resultCount: 0, successCount: 0, failedCount: 0 },
  };
  const agentModelSummary = useMemo(
    () => (globalSelectorSummary?.groups || []).map((group) => ({
      title: group.title,
      entries: (group.entries || []).map((entry) => {
        const chain = entry.chain || [];
        const primary = chain.find((item) => item.role === 'primary') || null;
        const fallbacks = chain.filter((item) => item.role !== 'primary');
        return {
          key: entry.key,
          label: entry.label,
          primaryProvider: primary?.provider || null,
          primaryModel: primary?.model || null,
          fallbackCount: fallbacks.length,
          fallbackText: fallbacks.length
            ? fallbacks.map((item) => `${item.provider} / ${item.model}`).join(' -> ')
            : 'fallback 없음',
          hasModel: Boolean(primary),
        };
      }),
    })),
    [globalSelectorSummary],
  );
  const agentModelTotals = useMemo(() => {
    const entries = agentModelSummary.flatMap((group) => group.entries || []);
    return {
      total: entries.length,
      withModel: entries.filter((entry) => entry.hasModel).length,
      withoutModel: entries.filter((entry) => !entry.hasModel).length,
    };
  }, [agentModelSummary]);
  const allAgentRows = useMemo(
    () => agentModelSummary.flatMap((group) =>
      (group.entries || []).map((entry) => ({
        team: group.title,
        key: entry.key,
        label: entry.label,
        hasModel: entry.hasModel,
        primaryText: entry.hasModel
          ? `${entry.primaryProvider} / ${entry.primaryModel}`
          : '미적용',
        fallbackText: entry.hasModel
          ? entry.fallbackText
          : '미적용',
        statusText: entry.hasModel
          ? `적용됨 · fallback ${entry.fallbackCount}`
          : '미적용',
      })),
    ),
    [agentModelSummary],
  );
  const globalSuggestionCount = Number(globalSelectorSummary?.override_suggestions?.count || 0);

  useEffect(() => {
    const keys = Object.keys(selectorEditors);
    if (!keys.length) return;
    setSelectorEdits((prev) => {
      const next = { ...prev };
      for (const key of keys) {
        const editor = selectorEditors[key];
        const selectedRole = next[key]?.role || editor.roleOptions?.[0]?.role || 'primary';
        const selectedRoleMeta = (editor.roleOptions || []).find((item) => item.role === selectedRole) || editor.roleOptions?.[0] || null;
        const currentProvider = next[key]?.provider || selectedRoleMeta?.provider || editor.currentProvider || editor.providerOptions?.[0]?.key || 'openai';
        const modelOptions = editor.modelOptionsByProvider?.[currentProvider] || [];
        const nextModel = modelOptions.some((item) => item.model === next[key]?.model)
          ? next[key].model
          : (selectedRoleMeta?.model && modelOptions.some((item) => item.model === selectedRoleMeta.model)
            ? selectedRoleMeta.model
            : (modelOptions[0]?.model || ''));
        next[key] = {
          role: selectedRole,
          provider: currentProvider,
          model: nextModel,
        };
      }
      return next;
    });
  }, [selectorEditors]);

  function handleSelectorRoleChange(key, role) {
    const editor = selectorEditors[key];
    const roleMeta = (editor?.roleOptions || []).find((item) => item.role === role) || null;
    const provider = roleMeta?.provider || editor?.providerOptions?.[0]?.key || 'openai';
    const modelOptions = editor?.modelOptionsByProvider?.[provider] || [];
    const model = roleMeta?.model && modelOptions.some((item) => item.model === roleMeta.model)
      ? roleMeta.model
      : (modelOptions[0]?.model || '');
    setSelectorEdits((prev) => ({
      ...prev,
      [key]: {
        role,
        provider,
        model,
      },
    }));
  }

  function handleSelectorProviderChange(key, provider) {
    const editor = selectorEditors[key];
    const modelOptions = editor?.modelOptionsByProvider?.[provider] || [];
    setSelectorEdits((prev) => ({
      ...prev,
      [key]: {
        ...(prev[key] || {}),
        provider,
        model: modelOptions[0]?.model || '',
      },
    }));
  }

  function handleSelectorModelChange(key, model) {
    setSelectorEdits((prev) => ({
      ...prev,
      [key]: {
        ...(prev[key] || {}),
        model,
      },
    }));
  }

  async function handleSaveSelector(key) {
    const draft = selectorEdits[key];
    if (!draft?.provider || !draft?.model) return;
    setSelectorSavingKey(key);
    setSaving(true);
    setNotice('');
    setError('');
    try {
      const data = await api.put('/admin/monitoring/llm-api/selector', {
        key,
        role: draft.role || 'primary',
        provider: draft.provider,
        model: draft.model,
      });
      setPayload(data);
      setNotice(data.message || 'selector 설정을 저장했습니다.');
    } catch (err) {
      setError(err.message || 'selector 설정을 저장하지 못했습니다.');
    } finally {
      setSelectorSavingKey('');
      setSaving(false);
    }
  }

  async function handleRunSpeedTest() {
    setSpeedRunning(true);
    setError('');
    setNotice('');
    try {
      const data = await api.post('/admin/monitoring/llm-api/speed-test', {});
      setPayload(data);
      setNotice(data.message || '속도 테스트를 실행했습니다.');
    } catch (err) {
      setError(err.message || '속도 테스트를 실행하지 못했습니다.');
    } finally {
      setSpeedRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <AdminQuickNav />

      <AdminPageHero
        title="LLM API 현황"
        badge="ADMIN"
        tone="slate"
        description="시스템 전체 LLM primary / fallback / advisor 상태를 확인하고, 같은 화면 안에서 팀별 selector 컨트롤을 점진적으로 관리합니다."
        stats={[
          { label: '전사 체인', value: agentModelTotals.total || 0, caption: '전 팀 에이전트 기준' },
          { label: '추천 후보', value: globalSuggestionCount, caption: 'override 후보 수' },
          { label: '편집 방식', value: '리스트 기반', caption: 'provider → model 2단계 변경' },
        ]}
      />

      {error && <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
      {notice && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}
      <div className="card space-y-4">
        <div className="flex items-center gap-2">
          <Cpu className="h-5 w-5 text-violet-600" />
          <div>
            <p className="text-sm font-semibold text-slate-900">ai-agent-system 전체 에이전트 리스트</p>
            <p className="text-xs text-slate-500">전 에이전트를 팀별로 모두 나열하고, primary / fallback 적용 여부를 한 줄에서 바로 확인합니다. LLM 체인이 없으면 `미적용`으로 표시합니다.</p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium text-slate-500">에이전트/체인</p>
            <p className="mt-2 text-lg font-semibold text-slate-900">{agentModelTotals.total}</p>
            <p className="mt-1 text-xs text-slate-500">전 팀 selector 기준</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium text-slate-500">모델 연결됨</p>
            <p className="mt-2 text-lg font-semibold text-slate-900">{agentModelTotals.withModel}</p>
            <p className="mt-1 text-xs text-slate-500">primary 모델 확인 가능</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium text-slate-500">미적용</p>
            <p className="mt-2 text-lg font-semibold text-slate-900">{agentModelTotals.withoutModel}</p>
            <p className="mt-1 text-xs text-slate-500">LLM 체인 정보 없음</p>
          </div>
        </div>

        {allAgentRows.length ? (
          <div className="rounded-2xl border border-slate-200 bg-white">
            <div className="divide-y divide-slate-100">
              {allAgentRows.map((item) => (
                <div key={`all-agent-top-${item.key}`} className="px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                          {item.team}
                        </span>
                        <p className="text-sm font-semibold text-slate-900">{item.label}</p>
                      </div>
                      <p className="mt-1 font-mono text-[11px] text-slate-500">{item.key}</p>
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        item.hasModel ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-700'
                      }`}
                    >
                      {item.statusText}
                    </span>
                  </div>
                  <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                    <div className="rounded-xl bg-slate-50 px-3 py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Primary</p>
                      <p className={`mt-1 break-all font-mono text-[11px] ${item.hasModel ? 'text-slate-700' : 'text-slate-400'}`}>
                        {item.primaryText}
                      </p>
                    </div>
                    <div className="rounded-xl bg-slate-50 px-3 py-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Fallback</p>
                      <p className={`mt-1 break-all text-[11px] ${item.hasModel ? 'text-slate-600' : 'text-slate-400'}`}>
                        {item.fallbackText}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 rounded-xl border border-slate-200 bg-white px-3 py-3">
                    {selectorEditors[item.key]?.editable ? (
                      <>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs font-semibold text-slate-700">LLM API 변경</p>
                          <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
                            직접 편집 가능
                          </span>
                        </div>
                        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_auto]">
                          <div>
                            <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">대상 체인</label>
                            <select
                              className="input-base mt-1"
                              value={selectorEdits[item.key]?.role || selectorEditors[item.key]?.roleOptions?.[0]?.role || 'primary'}
                              onChange={(event) => handleSelectorRoleChange(item.key, event.target.value)}
                              disabled={loading || saving}
                            >
                              {(selectorEditors[item.key]?.roleOptions || []).map((option) => (
                                <option key={`${item.key}-${option.role}`} value={option.role}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">1단계 · API 제공업체</label>
                            <select
                              className="input-base mt-1"
                              value={selectorEdits[item.key]?.provider || selectorEditors[item.key]?.currentProvider || ''}
                              onChange={(event) => handleSelectorProviderChange(item.key, event.target.value)}
                              disabled={loading || saving}
                            >
                              {(selectorEditors[item.key]?.providerOptions || []).map((option) => (
                                <option key={`${item.key}-${option.key}`} value={option.key}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">2단계 · 모델</label>
                            <select
                              className="input-base mt-1"
                              value={selectorEdits[item.key]?.model || ''}
                              onChange={(event) => handleSelectorModelChange(item.key, event.target.value)}
                              disabled={loading || saving}
                            >
                              {((selectorEditors[item.key]?.modelOptionsByProvider?.[selectorEdits[item.key]?.provider || selectorEditors[item.key]?.currentProvider]) || []).map((option) => (
                                <option key={`${item.key}-${option.model}`} value={option.model}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="flex items-end">
                            <button
                              type="button"
                              className="btn-primary text-sm"
                              onClick={() => handleSaveSelector(item.key)}
                              disabled={loading || saving || selectorSavingKey === item.key || !selectorEdits[item.key]?.provider || !selectorEdits[item.key]?.model}
                            >
                              {selectorSavingKey === item.key ? '저장 중...' : '적용'}
                            </button>
                          </div>
                        </div>
                        <p className="mt-2 text-[11px] text-slate-500">
                          `대상 체인`에서 Primary 또는 Fallback을 고르면, 현재 그 역할에 적용된 provider / model 값으로 자동 동기화됩니다.
                        </p>
                      </>
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold text-slate-700">LLM API 변경</p>
                          <p className="mt-1 text-[11px] text-slate-500">현재 이 에이전트는 전역 현황 조회만 지원합니다. 직접 변경 경로는 아직 연결되지 않았습니다.</p>
                        </div>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                          읽기 전용
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
            전체 에이전트 리스트를 아직 불러오지 못했습니다.
          </div>
        )}
      </div>

      <div className="card space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-indigo-600" />
            <div>
              <p className="text-sm font-semibold text-slate-900">속도 테스트</p>
              <p className="text-xs text-slate-500">속도 테스트 실행 버튼, API 대상 목록, 최신 측정 결과를 같은 카드에서 확인합니다. 전사 selector 추천의 운영 근거로 사용됩니다.</p>
            </div>
          </div>
          <button
            type="button"
            className="btn-primary text-sm"
            onClick={handleRunSpeedTest}
            disabled={loading || speedRunning}
          >
            {speedRunning ? '속도 테스트 실행 중...' : '속도 테스트 실행'}
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium text-slate-500">API 대상</p>
            <p className="mt-2 text-lg font-semibold text-slate-900">{speedTestConsole.summary?.targetCount || 0}</p>
            <p className="mt-1 text-xs text-slate-500">Hub selector 기준</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium text-slate-500">측정 결과</p>
            <p className="mt-2 text-lg font-semibold text-slate-900">{speedTestConsole.summary?.resultCount || 0}</p>
            <p className="mt-1 text-xs text-slate-500">최근 스냅샷 결과 수</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium text-slate-500">성공 / 실패</p>
            <p className="mt-2 text-lg font-semibold text-slate-900">
              {speedTestConsole.summary?.successCount || 0} / {speedTestConsole.summary?.failedCount || 0}
            </p>
            <p className="mt-1 text-xs text-slate-500">최근 실행 기준</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium text-slate-500">추천 상태</p>
            <p className="mt-2 text-lg font-semibold text-slate-900">{speedTestConsole.review?.recommendation || 'observe'}</p>
            <p className="mt-1 text-xs text-slate-500">최근 7일 review 기준</p>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
          <div className="rounded-2xl border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-4 py-3">
              <p className="text-sm font-semibold text-slate-900">API 대상 목록</p>
              <p className="mt-1 text-xs text-slate-500">속도 테스트가 순회하는 provider / model 목록입니다.</p>
            </div>
            <div className="divide-y divide-slate-100">
              {speedTestConsole.targets?.length ? (
                speedTestConsole.targets.map((item) => (
                  <div key={`speed-target-${item.modelId}`} className="px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                        {item.provider}
                      </span>
                      <p className="break-all font-mono text-[11px] text-slate-500">{item.modelId}</p>
                    </div>
                    <p className="mt-2 text-sm font-semibold text-slate-900">{item.label}</p>
                  </div>
                ))
              ) : (
                <div className="px-4 py-5 text-sm text-slate-500">등록된 속도 테스트 대상 목록을 아직 불러오지 못했습니다.</div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <p className="text-sm font-semibold text-slate-900">속도 측정 요약</p>
              {speedTestConsole.latest ? (
                <div className="mt-3 space-y-2 text-xs text-slate-600">
                  <p>최근 실행: {speedTestConsole.latest.capturedAt ? new Date(speedTestConsole.latest.capturedAt).toLocaleString('ko-KR') : '-'}</p>
                  <p>현재 primary: {speedTestConsole.latest.current || '-'}</p>
                  <p>추천 모델: {speedTestConsole.latest.recommended || '-'}</p>
                  <p>반복 횟수: {speedTestConsole.latest.runs || 0}</p>
                  <p>최근 7일 스냅샷: {speedTestConsole.review?.snapshotCount || 0}건</p>
                </div>
              ) : (
                <p className="mt-3 text-xs text-slate-500">아직 속도 테스트 스냅샷이 없습니다. 실행 버튼으로 첫 측정을 시작할 수 있습니다.</p>
              )}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white">
              <div className="border-b border-slate-200 px-4 py-3">
                <p className="text-sm font-semibold text-slate-900">속도 측정 결과</p>
                <p className="mt-1 text-xs text-slate-500">최근 스냅샷의 provider / model별 TTFT와 총 응답시간입니다.</p>
              </div>
              <div className="divide-y divide-slate-100">
                {speedTestConsole.results?.length ? (
                  speedTestConsole.results.map((item) => (
                    <div key={`speed-result-${item.modelId}`} className="px-4 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                              {item.provider}
                            </span>
                            <p className="text-sm font-semibold text-slate-900">{item.label}</p>
                          </div>
                          <p className="mt-1 break-all font-mono text-[11px] text-slate-500">{item.modelId}</p>
                        </div>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${item.ok ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                          {item.ok ? `성공 · #${item.rank}` : '실패'}
                        </span>
                      </div>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                        <div className="rounded-xl bg-slate-50 px-3 py-2">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">TTFT</p>
                          <p className="mt-1 text-sm font-semibold text-slate-900">{item.ttft != null ? `${item.ttft}ms` : '측정 실패'}</p>
                        </div>
                        <div className="rounded-xl bg-slate-50 px-3 py-2">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">총 응답시간</p>
                          <p className="mt-1 text-sm font-semibold text-slate-900">{item.total != null ? `${item.total}ms` : '측정 실패'}</p>
                        </div>
                      </div>
                      {!item.ok && item.error ? (
                        <p className="mt-2 text-xs text-rose-600">{item.error}</p>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <div className="px-4 py-5 text-sm text-slate-500">속도 측정 결과가 아직 없습니다.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
        <div className="space-y-6">
          <div className="card space-y-4">
            <div className="flex items-center gap-2">
              <BrainCircuit className="h-5 w-5 text-indigo-600" />
              <div>
                <p className="text-sm font-semibold text-slate-900">현재 로그인 정책</p>
                <p className="text-xs text-slate-500">이 값은 마스터 사용자에게 적용되는 AI UI/LLM 정책입니다. 전사 selector 체인과는 별도 축으로 관리됩니다.</p>
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

          <div className="card space-y-4">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-emerald-600" />
              <div>
                <p className="text-sm font-semibold text-slate-900">현재 활성 컨트롤 운영 데이터</p>
                <p className="text-xs text-slate-500">현재는 Worker 팀 컨트롤 경로에 대해서만 호출량, 성공률, 응답시간, 비용을 집계합니다. 전사 단일 화면 안에서 현재 실제 운영 데이터가 연결된 범위를 명확히 보여줍니다.</p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-xs font-medium text-slate-500">총 호출</p>
                <p className="mt-2 text-lg font-semibold text-slate-900">{usageSummary.totalCalls}</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-xs font-medium text-slate-500">성공 / 실패</p>
                <p className="mt-2 text-lg font-semibold text-slate-900">
                  {usageSummary.successCalls} / {usageSummary.failedCalls}
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-xs font-medium text-slate-500">성공률</p>
                <p className="mt-2 text-lg font-semibold text-slate-900">{Number(usageSummary.successRatePct || 0).toFixed(1)}%</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-xs font-medium text-slate-500">평균 응답시간</p>
                <p className="mt-2 text-lg font-semibold text-slate-900">
                  {usageSummary.avgLatencyMs !== null ? `${usageSummary.avgLatencyMs}ms` : '기록 없음'}
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-xs font-medium text-slate-500">추정 비용</p>
                <p className="mt-2 text-lg font-semibold text-slate-900">${Number(usageSummary.totalCostUsd || 0).toFixed(4)}</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-xs font-medium text-slate-500">마지막 호출</p>
                <p className="mt-2 text-sm font-semibold text-slate-900">
                  {usageSummary.latestCallAt ? new Date(usageSummary.latestCallAt).toLocaleString('ko-KR') : '기록 없음'}
                </p>
              </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-white">
                <div className="border-b border-slate-200 px-4 py-3">
                  <p className="text-sm font-semibold text-slate-900">Worker provider별 사용량</p>
                </div>
                <div className="divide-y divide-slate-100">
                  {usageSummary.byProvider.length ? (
                    usageSummary.byProvider.map((item) => (
                      <div key={item.provider} className="px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">{item.label}</p>
                            <p className="mt-1 break-all font-mono text-[11px] text-slate-500">{item.latestModel || '-'}</p>
                          </div>
                          <p className="text-sm font-semibold text-slate-900">{item.calls}회</p>
                        </div>
                        <p className="mt-2 text-xs text-slate-500">
                          성공 {item.successCalls} / 실패 {item.failedCalls} · 비용 ${Number(item.totalCostUsd || 0).toFixed(4)}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          성공률 {Number(item.successRatePct || 0).toFixed(1)}% · 평균 응답시간 {item.avgLatencyMs !== null ? `${item.avgLatencyMs}ms` : '기록 없음'}
                        </p>
                      </div>
                    ))
                  ) : (
                    <div className="px-4 py-5 text-sm text-slate-500">최근 24시간 API 호출 기록이 없습니다.</div>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white">
                <div className="border-b border-slate-200 px-4 py-3">
                  <p className="text-sm font-semibold text-slate-900">Worker 경로별 사용량</p>
                </div>
                <div className="divide-y divide-slate-100">
                  {usageSummary.byRoute.length ? (
                    usageSummary.byRoute.map((item) => (
                      <div key={item.route} className="px-4 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="break-all font-mono text-xs text-slate-700">{item.route}</p>
                          <p className="text-sm font-semibold text-slate-900">{item.calls}회</p>
                        </div>
                        <p className="mt-2 text-xs text-slate-500">
                          성공 {item.successCalls} / 실패 {item.failedCalls}
                          {` · 성공률 ${Number(item.successRatePct || 0).toFixed(1)}%`}
                          {` · 평균 응답시간 ${item.avgLatencyMs !== null ? `${item.avgLatencyMs}ms` : '기록 없음'}`}
                          {item.latestCallAt ? ` · 마지막 ${new Date(item.latestCallAt).toLocaleString('ko-KR')}` : ''}
                        </p>
                      </div>
                    ))
                  ) : (
                    <div className="px-4 py-5 text-sm text-slate-500">최근 24시간 경로별 호출 기록이 없습니다.</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-6">

          <div className="card space-y-4">
            <div className="flex items-center gap-2">
              <RefreshCcw className="h-5 w-5 text-amber-600" />
              <div>
                <p className="text-sm font-semibold text-slate-900">현재 활성 컨트롤 변경 이력</p>
                <p className="text-xs text-slate-500">현재는 Worker 팀 컨트롤에 대해서만 누가 언제 preferred provider를 바꿨는지 이력을 보여줍니다.</p>
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              {changeHistory.length ? (
                <div className="divide-y divide-slate-100">
                  {changeHistory.map((item) => (
                    <div key={item.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-slate-900">
                            {item.previous_api_label} → {item.next_api_label}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {item.changed_by_name} · {item.changed_by_role || 'role-unknown'}
                          </p>
                          {item.change_note ? (
                            <p className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
                              사유: {item.change_note}
                            </p>
                          ) : null}
                        </div>
                        <p className="text-xs text-slate-500">{new Date(item.changed_at).toLocaleString('ko-KR')}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="px-4 py-5 text-sm text-slate-500">아직 활성 컨트롤 변경 이력이 없습니다.</div>
              )}
            </div>
          </div>

          <div className="card space-y-4">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-sky-600" />
              <div>
                <p className="text-sm font-semibold text-slate-900">현재 활성 컨트롤 변경 전후 비교</p>
                <p className="text-xs text-slate-500">현재는 Worker 팀 컨트롤 변경을 기준으로, 전후 {changeImpact[0]?.window_hours || 12}시간의 성공률과 평균 응답시간을 비교합니다.</p>
              </div>
            </div>

            <div className="space-y-3">
              {changeImpact.length ? (
                changeImpact.map((item) => (
                  <div key={item.id} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">
                          {item.previous_api_label} → {item.next_api_label}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          변경 시각 {new Date(item.changed_at).toLocaleString('ko-KR')}
                        </p>
                        {item.change_note ? (
                          <p className="mt-2 rounded-xl bg-white px-3 py-2 text-xs leading-5 text-slate-600">
                            사유: {item.change_note}
                          </p>
                        ) : null}
                      </div>
                      <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${item.enough_data ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
                        {item.enough_data ? '비교 가능' : '데이터 부족'}
                      </span>
                    </div>

                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <div className="rounded-xl bg-white px-3 py-3">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">변경 전</p>
                        <p className="mt-2 text-sm font-semibold text-slate-900">{item.before.totalCalls}회 · 성공률 {Number(item.before.successRatePct || 0).toFixed(1)}%</p>
                        <p className="mt-1 text-xs text-slate-500">
                          평균 응답시간 {item.before.avgLatencyMs !== null ? `${item.before.avgLatencyMs}ms` : '기록 없음'}
                        </p>
                      </div>
                      <div className="rounded-xl bg-white px-3 py-3">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">변경 후</p>
                        <p className="mt-2 text-sm font-semibold text-slate-900">{item.after.totalCalls}회 · 성공률 {Number(item.after.successRatePct || 0).toFixed(1)}%</p>
                        <p className="mt-1 text-xs text-slate-500">
                          평균 응답시간 {item.after.avgLatencyMs !== null ? `${item.after.avgLatencyMs}ms` : '기록 없음'}
                        </p>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
                      <span className="rounded-full bg-white px-3 py-1">
                        성공률 변화 {item.success_rate_delta_pct > 0 ? '+' : ''}{Number(item.success_rate_delta_pct || 0).toFixed(1)}%p
                      </span>
                      <span className="rounded-full bg-white px-3 py-1">
                        응답시간 변화 {item.avg_latency_delta_ms === null ? '기록 없음' : `${item.avg_latency_delta_ms > 0 ? '+' : ''}${item.avg_latency_delta_ms}ms`}
                      </span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                  아직 활성 컨트롤 전후 비교를 계산할 만큼 최근 변경 이력이 없습니다.
                </div>
              )}
            </div>
          </div>

          <div className="card space-y-4">
            <div className="flex items-center gap-2">
              <BrainCircuit className="h-5 w-5 text-violet-600" />
              <div>
                <p className="text-sm font-semibold text-slate-900">전 팀 selector 상세</p>
                <p className="text-xs text-slate-500">시스템 전체 LLM primary / fallback 체인, advisor, override 후보를 팀별로 더 자세히 확인합니다.</p>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">override 추천 후보</p>
                  <p className="mt-1 text-xs text-slate-500">advisor 기준으로 compare / switch_candidate 대상만 추려 보여줍니다.</p>
                </div>
                <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700">
                  {globalSelectorSummary?.override_suggestions?.count || 0}건
                </span>
              </div>
              {(globalSelectorSummary?.override_suggestions?.suggestions || []).length ? (
                <div className="mt-3 space-y-2">
                  {globalSelectorSummary.override_suggestions.suggestions.map((item) => (
                    <div key={`${item.key}-${item.candidate}`} className="rounded-xl bg-white px-3 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${adviceTone[item.decision] || adviceTone.observe}`}>
                          {item.decision}
                        </span>
                        <span className="text-sm font-semibold text-slate-900">{item.label}</span>
                      </div>
                      <p className="mt-2 text-[11px] text-slate-600">
                        current {item.currentPrimary || '-'} → candidate {item.candidate || '-'}
                      </p>
                      <p className="mt-1 break-all font-mono text-[11px] text-slate-500">
                        {item.config || '-'} · {item.path || '-'}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-600">{item.reason}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-xs text-slate-500">현재 speed-test 기준으로 추천 후보가 없습니다.</p>
              )}
            </div>

            <div className="space-y-4">
              {(globalSelectorSummary?.groups || []).map((group) => (
                <div key={group.title} className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                  <p className="text-sm font-semibold text-slate-900">{group.title}</p>
                  <div className="mt-3 space-y-3">
                    {(group.entries || []).map((entry) => (
                      <div key={entry.key} className="rounded-xl bg-slate-50 px-3 py-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold text-slate-900">{entry.label}</p>
                            <p className="mt-1 font-mono text-[11px] text-slate-500">{entry.key}</p>
                          </div>
                        </div>
                        <div className="mt-2 space-y-1">
                          {entry.advice ? (
                            <div className="mb-2 rounded-lg bg-white px-3 py-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${adviceTone[entry.advice.decision] || adviceTone.observe}`}>
                                  {entry.advice.decision}
                                </span>
                                {entry.advice.candidate ? (
                                  <span className="rounded-full bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-600">
                                    candidate {entry.advice.candidate}
                                  </span>
                                ) : null}
                              </div>
                              <p className="mt-2 text-[11px] text-slate-600">{entry.advice.reason}</p>
                            </div>
                          ) : null}
                          {(entry.chain || []).map((chainEntry) => (
                            <p key={`${entry.key}-${chainEntry.role}`} className="break-all text-[11px] text-slate-600">
                              <span className="font-semibold uppercase tracking-wide text-slate-500">{chainEntry.role}</span>
                              {` · ${chainEntry.provider} / ${chainEntry.model}`}
                            </p>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
