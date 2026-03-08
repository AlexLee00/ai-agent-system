'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';

const STATUS_CONFIG = {
  planning:    { label: '기획',   color: 'bg-blue-50 text-blue-700 border-blue-200',   dot: 'bg-blue-500' },
  in_progress: { label: '진행중', color: 'bg-yellow-50 text-yellow-700 border-yellow-200', dot: 'bg-yellow-500' },
  review:      { label: '검토',   color: 'bg-orange-50 text-orange-700 border-orange-200', dot: 'bg-orange-500' },
  completed:   { label: '완료',   color: 'bg-green-50 text-green-700 border-green-200',  dot: 'bg-green-500' },
};

const TABS = [
  { key: 'active',    label: '진행 중' },
  { key: 'completed', label: '완료' },
  { key: 'all',       label: '전체' },
];

function ProjectCard({ project }) {
  const cfg = STATUS_CONFIG[project.status] || {};
  const pct = Number(project.progress ?? 0);

  return (
    <Link href={`/projects/${project.id}`} className="card hover:shadow-md transition-shadow cursor-pointer block">
      <div className="flex items-start justify-between gap-2 mb-3">
        <h3 className="font-semibold text-gray-900 leading-snug">{project.name}</h3>
        <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full border ${cfg.color}`}>
          {cfg.label ?? project.status}
        </span>
      </div>

      {/* 진행률 바 */}
      <div className="mb-3">
        <div className="flex justify-between text-xs text-gray-500 mb-1">
          <span>진행률</span>
          <span className="font-medium">{pct}%</span>
        </div>
        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${cfg.dot ?? 'bg-indigo-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {project.end_date && (
        <p className="text-xs text-gray-400">마감: {project.end_date.slice(0, 10)}</p>
      )}
    </Link>
  );
}

function CreateModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.post('/projects', { name: name.trim() });
      onCreated();
      onClose();
    } catch (e) { alert(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
        <h3 className="font-bold text-gray-900 mb-4">📋 새 프로젝트</h3>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">프로젝트명</label>
            <input
              className="input-base w-full"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="프로젝트 이름"
              autoFocus
            />
          </div>
          <div className="flex gap-2 pt-2">
            <button type="button" className="btn-secondary flex-1" onClick={onClose}>취소</button>
            <button type="submit" className="btn-primary flex-1" disabled={saving || !name.trim()}>
              {saving ? '생성 중...' : '생성'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [tab,      setTab]      = useState('active');
  const [showCreate, setShowCreate] = useState(false);

  const load = () => {
    setLoading(true);
    api.get('/projects').then(d => setProjects(d.projects || [])).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const filtered = projects.filter(p => {
    if (tab === 'active')    return p.status !== 'completed';
    if (tab === 'completed') return p.status === 'completed';
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">📋 프로젝트</h1>
        <button className="btn-primary text-sm" onClick={() => setShowCreate(true)}>+ 새 프로젝트</button>
      </div>

      {/* 탭 */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        {TABS.map(t => (
          <button
            key={t.key}
            className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
              tab === t.key ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'
            }`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 카드 그리드 */}
      {loading ? (
        <div className="text-center py-16 text-gray-400">로딩 중...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-4xl mb-3">📋</p>
          <p className="text-sm">프로젝트 없음</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(p => <ProjectCard key={p.id} project={p} />)}
        </div>
      )}

      {showCreate && <CreateModal onClose={() => setShowCreate(false)} onCreated={load} />}
    </div>
  );
}
