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
  const [changeNote, setChangeNote] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.get('/admin/monitoring/llm-api');
      setPayload(data);
      setSelectedProvider(data.selected_api || 'groq');
      setChangeNote('');
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
  const selectorSummary = payload?.selector_summary || [];
  const globalSelectorSummary = payload?.global_selector_summary || null;

  async function handleSaveProvider() {
    setSaving(true);
    setNotice('');
    setError('');
    try {
      const requestBody = { provider: selectedProvider, note: changeNote.trim() || undefined };
      const data = await api.put('/admin/monitoring/llm-api', requestBody);
      setPayload(data);
      setSelectedProvider(data.selected_api || selectedProvider);
      setChangeNote('');
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
              <div className="mt-4">
                <label className="block text-xs font-semibold text-slate-500">변경 사유</label>
                <textarea
                  className="input-base mt-2 min-h-[92px]"
                  value={changeNote}
                  onChange={(event) => setChangeNote(event.target.value)}
                  placeholder="예: 응답시간 비교를 위해 Groq에서 OpenAI로 전환"
                  maxLength={300}
                  disabled={loading || saving}
                />
                <p className="mt-2 text-[11px] text-slate-500">
                  변경 이유를 남겨두면 호출량/성공률 변화와 함께 나중에 판단하기 쉽습니다. {changeNote.length}/300
                </p>
              </div>
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

          <div className="card space-y-4">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-emerald-600" />
              <div>
                <p className="text-sm font-semibold text-slate-900">최근 {usageSummary.periodHours}시간 호출 통계</p>
                <p className="text-xs text-slate-500">워커 웹 관리자 분석 경로에서 실제로 어떤 API와 경로가 얼마나 호출됐는지 보여줍니다.</p>
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
                  <p className="text-sm font-semibold text-slate-900">API별 사용량</p>
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
                  <p className="text-sm font-semibold text-slate-900">경로별 사용량</p>
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

          <div className="card space-y-4">
            <div className="flex items-center gap-2">
              <Cpu className="h-5 w-5 text-indigo-600" />
              <div>
                <p className="text-sm font-semibold text-slate-900">현재 selector / fallback 체인</p>
                <p className="text-xs text-slate-500">워커 내부에서 실제 primary와 fallback이 어떤 순서로 적용되는지 보여줍니다.</p>
              </div>
            </div>

            <div className="space-y-3">
              {selectorSummary.length ? (
                selectorSummary.map((selector) => (
                  <div key={selector.key} className="rounded-2xl border border-slate-200 bg-white px-4 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">{selector.label}</p>
                        <p className="mt-1 font-mono text-[11px] text-slate-500">{selector.route}</p>
                      </div>
                      <span className="rounded-full bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-600">{selector.key}</span>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">{selector.description}</p>
                    <div className="mt-3 space-y-2">
                      {(selector.chain || []).map((entry) => (
                        <div key={`${selector.key}-${entry.role}`} className="rounded-xl bg-slate-50 px-3 py-2">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{entry.role}</p>
                            <p className="text-xs text-slate-500">{entry.provider}</p>
                          </div>
                          <p className="mt-1 break-all font-mono text-[11px] text-slate-700">{entry.model}</p>
                          {(entry.maxTokens || entry.temperature !== null) && (
                            <p className="mt-1 text-[11px] text-slate-500">
                              {entry.maxTokens ? `maxTokens ${entry.maxTokens}` : ''}
                              {entry.maxTokens && entry.temperature !== null ? ' · ' : ''}
                              {entry.temperature !== null ? `temperature ${entry.temperature}` : ''}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                  selector 체인 정보를 불러오지 못했습니다.
                </div>
              )}
            </div>
          </div>

          <div className="card space-y-4">
            <div className="flex items-center gap-2">
              <RefreshCcw className="h-5 w-5 text-amber-600" />
              <div>
                <p className="text-sm font-semibold text-slate-900">기본 API 변경 이력</p>
                <p className="text-xs text-slate-500">누가 언제 워커 웹 기본 분석 API를 바꿨는지 최근 이력을 보여줍니다.</p>
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
                <div className="px-4 py-5 text-sm text-slate-500">아직 기본 API 변경 이력이 없습니다.</div>
              )}
            </div>
          </div>

          <div className="card space-y-4">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-sky-600" />
              <div>
                <p className="text-sm font-semibold text-slate-900">최근 변경 전후 품질 비교</p>
                <p className="text-xs text-slate-500">최근 변경 기준 전후 {changeImpact[0]?.window_hours || 12}시간의 성공률과 평균 응답시간을 비교합니다.</p>
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
                  아직 전후 비교를 계산할 만큼 최근 변경 이력이 없습니다.
                </div>
              )}
            </div>
          </div>

          <div className="card space-y-4">
            <div className="flex items-center gap-2">
              <BrainCircuit className="h-5 w-5 text-violet-600" />
              <div>
                <p className="text-sm font-semibold text-slate-900">전 팀 selector 개요</p>
                <p className="text-xs text-slate-500">현재 시스템 전체 LLM primary / fallback 체인을 한 화면에서 요약합니다.</p>
              </div>
            </div>

            {globalSelectorSummary?.speed_test ? (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                최근 speed-test {new Date(globalSelectorSummary.speed_test.captured_at).toLocaleString('ko-KR')}
                {` · current ${globalSelectorSummary.speed_test.current || '-'}`}
                {` · recommended ${globalSelectorSummary.speed_test.recommended || '-'}`}
              </div>
            ) : (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
                최근 speed-test 스냅샷이 없습니다.
              </div>
            )}

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
