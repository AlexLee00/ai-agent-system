'use client';

import { useEffect, useMemo, useState } from 'react';
import { Activity, Brain, Users, Zap } from 'lucide-react';
import AdminPageHero from '@/components/AdminPageHero';
import AgentCharts from '@/components/AgentCharts';
import AdminQuickNav from '@/components/AdminQuickNav';
import DotCharacter from '@/components/DotCharacter';
import { api } from '@/lib/api';

const TEAM_COLORS = {
  blog: 'border-blue-200 bg-blue-50',
  luna: 'border-amber-200 bg-amber-50',
  claude: 'border-emerald-200 bg-emerald-50',
  ska: 'border-teal-200 bg-teal-50',
  worker: 'border-purple-200 bg-purple-50',
  video: 'border-pink-200 bg-pink-50',
  research: 'border-indigo-200 bg-indigo-50',
  legal: 'border-slate-300 bg-slate-50',
  data: 'border-cyan-200 bg-cyan-50',
  jay: 'border-orange-200 bg-orange-50',
};

const TEAM_LABELS = {
  all: '전체',
  blog: '블로',
  luna: '루나',
  claude: '클로드',
  ska: '스카',
  worker: '워커',
  video: '에디',
  research: '연구',
  legal: '감정',
  data: '데이터',
  jay: '제이',
};

const STATUS_BADGE = {
  active: { label: '작업중', cls: 'bg-emerald-100 text-emerald-700' },
  idle: { label: '대기', cls: 'bg-slate-100 text-slate-600' },
  learning: { label: '학습', cls: 'bg-blue-100 text-blue-700' },
  archived: { label: '보관', cls: 'bg-rose-100 text-rose-700' },
};

function toScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? score : 0;
}

function toEmotionScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  return score > 10 ? Math.min(10, Math.round(score / 10)) : Math.min(10, Math.round(score));
}

function getAlwaysOnDot(updatedAt) {
  if (!updatedAt) return '🔴';
  const mins = Math.floor((Date.now() - new Date(updatedAt).getTime()) / 60000);
  if (mins < 5) return '🟢';
  if (mins < 15) return '🟡';
  return '🔴';
}

export default function AgentOfficePage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dashboard, setDashboard] = useState(null);
  const [selectedTeam, setSelectedTeam] = useState('all');
  const [selectedAgent, setSelectedAgent] = useState(null);

  useEffect(() => {
    let mounted = true;
    api.get('/agents/dashboard')
      .then((data) => {
        if (!mounted) return;
        setDashboard(data);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err.message || '에이전트 오피스 데이터를 불러오지 못했습니다.');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const agents = useMemo(() => {
    const allAgents = Array.isArray(dashboard?.agents) ? dashboard.agents : [];
    if (selectedTeam === 'all') return allAgents;
    return allAgents.filter((agent) => agent.team === selectedTeam);
  }, [dashboard, selectedTeam]);

  const teams = useMemo(() => {
    const allAgents = Array.isArray(dashboard?.agents) ? dashboard.agents : [];
    return Array.from(new Set(allAgents.map((agent) => agent.team).filter(Boolean))).sort();
  }, [dashboard]);

  const stats = dashboard?.stats || {};
  const alwaysOn = dashboard?.alwaysOn || [];

  if (loading) {
    return <div className="p-8 text-center text-sm text-slate-500">에이전트 오피스를 불러오는 중입니다.</div>;
  }

  if (error) {
    return <div className="p-8 text-center text-sm text-rose-600">{error}</div>;
  }

  return (
    <div className="space-y-6">
      <AdminQuickNav />

      <AdminPageHero
        title="AGENT OFFICE"
        badge="ADMIN"
        tone="indigo"
        description="상시 에이전트 상태와 팀별 카드, 개별 에이전트의 점수·모델·작업·내적 상태를 한 화면에서 확인합니다."
        stats={[
          { label: '전체 에이전트', value: stats.total_count || agents.length || 0, caption: 'Registry 기준' },
          { label: '활성', value: stats.active_count || 0, caption: '현재 작업중' },
          { label: '대기', value: stats.idle_count || 0, caption: '즉시 호출 가능' },
          { label: '학습', value: stats.learning_count || 0, caption: '실험/학습 상태' },
        ]}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-3xl border border-slate-200 bg-white px-4 py-4">
            <div className="flex items-center gap-2 text-slate-500">
              <Users className="h-4 w-4" />
              <span className="text-sm font-medium">상시 에이전트</span>
            </div>
            <p className="mt-2 text-2xl font-semibold text-slate-900">{alwaysOn.length}</p>
            <p className="mt-1 text-xs text-slate-400">heartbeat 기반 최근 활동</p>
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white px-4 py-4">
            <div className="flex items-center gap-2 text-slate-500">
              <Brain className="h-4 w-4" />
              <span className="text-sm font-medium">평균 점수</span>
            </div>
            <p className="mt-2 text-2xl font-semibold text-slate-900">
              {agents.length ? (agents.reduce((sum, agent) => sum + toScore(agent.score), 0) / agents.length).toFixed(1) : '0.0'}
            </p>
            <p className="mt-1 text-xs text-slate-400">현재 필터 기준</p>
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white px-4 py-4">
            <div className="flex items-center gap-2 text-slate-500">
              <Zap className="h-4 w-4" />
              <span className="text-sm font-medium">팀 수</span>
            </div>
            <p className="mt-2 text-2xl font-semibold text-slate-900">{teams.length}</p>
            <p className="mt-1 text-xs text-slate-400">현재 등록된 팀</p>
          </div>
        </div>
      </AdminPageHero>

      <section className="card space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <Activity className="h-4 w-4 text-emerald-600" />
          상시 에이전트
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {(alwaysOn || []).map((agent) => (
            <button
              key={agent.name}
              type="button"
              onClick={() => setSelectedAgent(agent)}
              className="inline-flex shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
            >
              <DotCharacter
                color={agent.dot_character?.color || '#10b981'}
                accessory={agent.dot_character?.accessory || 'none'}
                status={agent.status}
                size={22}
              />
              <span>{getAlwaysOnDot(agent.updated_at)}</span>
              <span>{agent.display_name || agent.name}</span>
              <span className="text-slate-400">{toScore(agent.score).toFixed(1)}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="card space-y-4">
        <div className="flex gap-2 overflow-x-auto">
          <button
            type="button"
            onClick={() => setSelectedTeam('all')}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
              selectedTeam === 'all'
                ? 'bg-slate-900 text-white'
                : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            전체
          </button>
          {teams.map((team) => (
            <button
              key={team}
              type="button"
              onClick={() => setSelectedTeam(team)}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                selectedTeam === team
                  ? 'bg-slate-900 text-white'
                  : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {TEAM_LABELS[team] || team}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          {agents.map((agent, index) => {
            const badge = STATUS_BADGE[agent.status] || STATUS_BADGE.idle;
            const teamClass = TEAM_COLORS[agent.team] || 'border-slate-200 bg-slate-50';
            const emotion = agent.emotion_state || {};

            return (
              <button
                key={agent.name}
                type="button"
                onClick={() => setSelectedAgent(agent)}
                className={`agent-card-enter rounded-2xl border-2 p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md ${teamClass}`}
                style={{ animationDelay: `${index * 40}ms` }}
              >
                <div className={`mb-2 flex justify-center ${agent.status === 'active' ? 'animate-agent-float' : ''}`}>
                  <DotCharacter
                    color={agent.dot_character?.color || '#6366f1'}
                    accessory={agent.dot_character?.accessory || 'none'}
                    status={agent.status}
                    size={44}
                  />
                </div>
                <div className="truncate text-sm font-semibold text-slate-900">{agent.display_name || agent.name}</div>
                <div className="truncate text-xs text-slate-500">{agent.specialty || agent.role || '역할 미정'}</div>
                <div className="mt-2 flex items-center gap-1 text-sm font-semibold text-slate-800">
                  <span className="text-amber-500">⭐</span>
                  <span>{toScore(agent.score).toFixed(1)}</span>
                </div>
                <div className="mt-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>{badge.label}</span>
                </div>
                {emotion.confidence != null ? (
                  <div className="mt-2 text-xs text-slate-400">자신감 {toEmotionScore(emotion.confidence)}/10</div>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      <AgentCharts />

      {selectedAgent ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4"
          onClick={() => setSelectedAgent(null)}
        >
          <div
            className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex justify-center">
              <div className="animate-agent-float">
                <DotCharacter
                  color={selectedAgent.dot_character?.color || '#6366f1'}
                  accessory={selectedAgent.dot_character?.accessory || 'none'}
                  status={selectedAgent.status}
                  size={56}
                />
              </div>
            </div>
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  {selectedAgent.display_name || selectedAgent.name} ({selectedAgent.name})
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {selectedAgent.specialty || selectedAgent.role || '역할 미정'} · {(TEAM_LABELS[selectedAgent.team] || selectedAgent.team || '미지정')}팀
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedAgent(null)}
                className="text-xl text-slate-400 transition hover:text-slate-600"
              >
                ×
              </button>
            </div>

            <div className="space-y-3 text-sm text-slate-700">
              <div className="flex justify-between gap-4">
                <span className="text-slate-500">점수</span>
                <span className="font-semibold">⭐ {toScore(selectedAgent.score).toFixed(2)}/10</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-slate-500">모델</span>
                <span className="text-right">{selectedAgent.llm_model || '없음'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-slate-500">작업</span>
                <span className="text-right">{selectedAgent.total_tasks || 0}건 (성공 {selectedAgent.success_count || 0})</span>
              </div>

              {selectedAgent.emotion_state ? (
                <div className="space-y-2 pt-2">
                  <p className="text-sm font-medium text-slate-600">내적 상태</p>
                  {['confidence', 'fatigue', 'motivation'].map((key) => {
                    const value = toEmotionScore(selectedAgent.emotion_state[key]);
                    const label = {
                      confidence: '자신감',
                      fatigue: '피로도',
                      motivation: '동기',
                    }[key];
                    const color = key === 'fatigue' ? 'bg-rose-400' : 'bg-blue-400';
                    return (
                      <div key={key} className="flex items-center gap-3">
                        <span className="w-12 shrink-0 text-xs text-slate-400">{label}</span>
                        <div className="h-2 flex-1 rounded-full bg-slate-200">
                          <div className={`h-2 rounded-full ${color}`} style={{ width: `${value * 10}%` }} />
                        </div>
                        <span className="w-8 shrink-0 text-right text-xs text-slate-500">{value}/10</span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
