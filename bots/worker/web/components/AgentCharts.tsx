// @ts-nocheck
'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '@/lib/api';

const TABS = [
  { key: 'tokens', label: '토큰 소비' },
  { key: 'cost', label: '비용' },
  { key: 'errors', label: '에러율' },
  { key: 'quality', label: '품질' },
  { key: 'competition', label: '경쟁 결과' },
];

function groupByDay(stats) {
  const grouped = {};
  for (const row of stats || []) {
    const day = row.day ? String(row.day).slice(0, 10) : 'unknown';
    if (!grouped[day]) {
      grouped[day] = {
        day,
        total_tokens: 0,
        total_cost: 0,
        call_count: 0,
        error_count: 0,
        avg_quality_sum: 0,
        avg_quality_count: 0,
      };
    }
    grouped[day].total_tokens += Number(row.total_tokens || 0);
    grouped[day].total_cost += Number(row.total_cost || 0);
    grouped[day].call_count += Number(row.call_count || 0);
    grouped[day].error_count += Number(row.error_count || 0);
    if (row.avg_quality != null) {
      grouped[day].avg_quality_sum += Number(row.avg_quality || 0);
      grouped[day].avg_quality_count += 1;
    }
  }

  return Object.values(grouped)
    .map((row) => ({
      ...row,
      avg_quality: row.avg_quality_count ? Number((row.avg_quality_sum / row.avg_quality_count).toFixed(2)) : 0,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

function normalizeCompetitionData(competitions) {
  return (competitions || []).map((competition, index) => {
    const evalDetail = competition.evaluation_detail || {};
    const scoreA = Number(evalDetail.scoreA || competition.group_a_result?.quality || 0);
    const scoreB = Number(evalDetail.scoreB || competition.group_b_result?.quality || 0);
    return {
      round: `#${index + 1}`,
      topic: competition.topic,
      groupA: Number.isFinite(scoreA) ? Number(scoreA.toFixed(2)) : 0,
      groupB: Number.isFinite(scoreB) ? Number(scoreB.toFixed(2)) : 0,
    };
  }).reverse();
}

export default function AgentCharts() {
  const [activeTab, setActiveTab] = useState('tokens');
  const [traceData, setTraceData] = useState([]);
  const [competitionData, setCompetitionData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      api.get('/agents/stats/traces?days=7').catch(() => ({ stats: [] })),
      api.get('/agents/competition/history').catch(() => ({ competitions: [] })),
    ]).then(([traces, competitions]) => {
      if (!mounted) return;
      setTraceData(Array.isArray(traces?.stats) ? traces.stats : []);
      setCompetitionData(Array.isArray(competitions?.competitions) ? competitions.competitions : []);
      setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const dailyData = useMemo(() => groupByDay(traceData), [traceData]);
  const competitionChart = useMemo(() => normalizeCompetitionData(competitionData), [competitionData]);

  if (loading) {
    return <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">차트 로딩 중...</div>;
  }

  const chartData = activeTab === 'competition' ? competitionChart : dailyData;

  return (
    <section className="card space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">운영 차트</h3>
          <p className="mt-1 text-xs text-slate-400">trace-collector와 competition history를 기준으로 최근 7일 흐름을 보여줍니다.</p>
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTab === tab.key
                ? 'bg-slate-900 text-white'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="h-72 rounded-3xl border border-slate-100 bg-slate-50/70 p-3">
        <ResponsiveContainer width="100%" height="100%">
          {activeTab === 'tokens' ? (
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Area type="monotone" dataKey="total_tokens" fill="#6366f1" stroke="#4f46e5" fillOpacity={0.28} />
            </AreaChart>
          ) : null}

          {activeTab === 'cost' ? (
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="total_cost" fill="#10b981" radius={[6, 6, 0, 0]} />
            </BarChart>
          ) : null}

          {activeTab === 'errors' ? (
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Line type="monotone" dataKey="error_count" stroke="#ef4444" strokeWidth={2} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="call_count" stroke="#64748b" strokeWidth={1.5} strokeDasharray="5 5" dot={false} />
            </LineChart>
          ) : null}

          {activeTab === 'quality' ? (
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} />
              <YAxis domain={[0, 10]} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Line type="monotone" dataKey="avg_quality" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          ) : null}

          {activeTab === 'competition' ? (
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="round" tick={{ fontSize: 11 }} />
              <YAxis domain={[0, 10]} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="groupA" fill="#3b82f6" name="그룹 A" radius={[6, 6, 0, 0]} />
              <Bar dataKey="groupB" fill="#f59e0b" name="그룹 B" radius={[6, 6, 0, 0]} />
            </BarChart>
          ) : null}
        </ResponsiveContainer>
      </div>
    </section>
  );
}
