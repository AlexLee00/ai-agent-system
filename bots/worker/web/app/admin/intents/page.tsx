// @ts-nocheck
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import AdminQuickNav from '@/components/AdminQuickNav';
import AdminPageHero from '@/components/AdminPageHero';
import AdminQuickFlowGrid from '@/components/AdminQuickFlowGrid';

function CandidateCard({ candidate, busyId, onApply, onRollback }) {
  const statusTone = candidate.status === 'auto_applied'
    ? 'bg-green-100 text-green-700'
    : candidate.status === 'rollback'
      ? 'bg-slate-200 text-slate-700'
      : candidate.status === 'candidate'
        ? 'bg-amber-100 text-amber-700'
        : 'bg-slate-100 text-slate-600';

  return (
    <div className="card">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-slate-500">#{candidate.id}</span>
            <span className={`rounded-full px-2 py-1 text-xs font-semibold ${statusTone}`}>{candidate.status}</span>
            <span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600">{candidate.suggested_intent}</span>
          </div>
          <p className="text-sm font-medium text-slate-900">{candidate.sample_text}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
            <span>반복 {candidate.occurrence_count || 0}회</span>
            <span>신뢰도 {Math.round(Number(candidate.confidence || 0) * 100)}%</span>
            {candidate.reason ? <span>사유 {candidate.reason}</span> : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-col gap-2">
          <button
            className="btn-primary px-4 py-2 text-sm"
            disabled={busyId === candidate.id}
            onClick={() => onApply(candidate.id)}
          >
            적용
          </button>
          <button
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
            disabled={busyId === candidate.id}
            onClick={() => onRollback(candidate.id)}
          >
            롤백
          </button>
        </div>
      </div>
    </div>
  );
}

export default function WorkerIntentAdminPage() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [unrec, setUnrec] = useState({ summary: null, rows: [], candidates: [] });
  const [promotions, setPromotions] = useState({ summary: null, families: [], candidates: [], events: [] });

  const load = async (search = '') => {
    setLoading(true);
    try {
      const [unrecData, promoData] = await Promise.all([
        api.get(`/chat/unrec${search ? `?q=${encodeURIComponent(search)}` : ''}`),
        api.get(`/chat/promotions${search ? `?q=${encodeURIComponent(search)}` : ''}`),
      ]);
      setUnrec(unrecData);
      setPromotions(promoData);
    } catch (e) {
      alert(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const candidateCount = promotions?.candidates?.length || 0;
  const pendingCount = promotions?.summary?.pending_count || 0;
  const unrecCount = useMemo(
    () => (unrec?.rows || []).reduce((sum, row) => sum + Number(row.cnt || 0), 0),
    [unrec],
  );
  const quickFlows = [
    {
      title: '미인식 표현 점검',
      body: '최근 미인식 표현을 검토하고 워커 대화 흐름으로 바로 이어집니다.',
      promptHref: '/dashboard?prompt=' + encodeURIComponent('최근 미인식 워커 표현을 요약해줘'),
    },
    {
      title: '승격 후보 확인',
      body: '자동 승격 전 반복 패턴과 위험도를 빠르게 검토합니다.',
      promptHref: '/dashboard?prompt=' + encodeURIComponent('승격 대기 인텐트 후보를 요약해줘'),
    },
  ];

  const handleApply = async (id) => {
    setBusyId(id);
    try {
      await api.put(`/chat/promotions/${id}/apply`, {});
      await load(query);
    } catch (e) {
      alert(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleRollback = async (id) => {
    setBusyId(id);
    try {
      await api.put(`/chat/promotions/${id}/rollback`, {});
      await load(query);
    } catch (e) {
      alert(e.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      <AdminQuickNav />
      <AdminPageHero
        title="인텐트 학습"
        description="워커 자연어 대화에서 반복되는 표현을 보고, learned pattern으로 수동 반영하거나 롤백할 수 있습니다."
        stats={[
          { label: '미인식', value: unrecCount },
          { label: '대기 후보', value: pendingCount },
          { label: '표시 후보', value: candidateCount },
        ]}
      />

      <div className="card">
        <div className="flex flex-wrap items-center gap-3">
          <input
            className="min-w-[240px] flex-1 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none transition focus:border-slate-400"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='예: pending, applied, intent:route_request'
          />
          <button className="btn-primary px-4 py-3 text-sm" onClick={() => load(query)}>
            조회
          </button>
          <button
            className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
            onClick={() => {
              setQuery('');
              load('');
            }}
          >
            초기화
          </button>
        </div>
      </div>

      <AdminQuickFlowGrid
        items={quickFlows.map((item) => ({
          title: item.title,
          body: item.body,
          onPromptFill: () => router.push(item.promptHref),
          onSecondary: () => load(query),
          secondaryLabel: '현재 목록 새로고침',
        }))}
      />

      <div className="grid gap-5 xl:grid-cols-[1.4fr_0.9fr]">
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">후보 목록</h2>
            <p className="text-xs text-slate-500">master만 적용/롤백 가능</p>
          </div>
          {loading ? (
            <div className="card text-sm text-slate-400">불러오는 중...</div>
          ) : promotions.candidates?.length ? (
            promotions.candidates.map((candidate) => (
              <CandidateCard
                key={candidate.id}
                candidate={candidate}
                busyId={busyId}
                onApply={handleApply}
                onRollback={handleRollback}
              />
            ))
          ) : (
            <div className="card text-sm text-slate-400">표시할 인텐트 후보가 없습니다.</div>
          )}
        </section>

        <section className="space-y-4">
          <div className="card">
            <h2 className="text-base font-semibold text-slate-900">Intent Family</h2>
            <div className="mt-3 space-y-2">
              {(promotions.families || []).length ? promotions.families.map((family) => (
                <div key={family.family} className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{family.family}</p>
                    <p className="text-xs text-slate-500">후보 {family.total} / 반영 {family.applied}</p>
                  </div>
                  <p className="text-sm font-semibold text-slate-700">{family.occurrences}회</p>
                </div>
              )) : <p className="text-sm text-slate-400">아직 집계된 후보가 없습니다.</p>}
            </div>
          </div>

          <div className="card">
            <h2 className="text-base font-semibold text-slate-900">최근 이벤트</h2>
            <div className="mt-3 space-y-2">
              {(promotions.events || []).length ? promotions.events.map((event, index) => (
                <div key={`${event.created_at}-${index}`} className="rounded-2xl border border-slate-200 bg-white px-3 py-3">
                  <p className="text-sm font-medium text-slate-900">{event.event_type}</p>
                  <p className="mt-1 text-xs text-slate-500">{event.sample_text || '-'}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    {event.suggested_intent || '-'} · {event.actor || 'system'} · {new Date(event.created_at).toLocaleString('ko-KR')}
                  </p>
                </div>
              )) : <p className="text-sm text-slate-400">최근 이벤트가 없습니다.</p>}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
