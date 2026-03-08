'use client';
import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';

const STATUS_OPTIONS = [
  { value: 'planning',    label: '🔵 기획' },
  { value: 'in_progress', label: '🟡 진행중' },
  { value: 'review',      label: '🟠 검토' },
  { value: 'completed',   label: '🟢 완료' },
];

const STATUS_CONFIG = {
  planning:    { label: '기획',   bar: 'bg-blue-500' },
  in_progress: { label: '진행중', bar: 'bg-yellow-500' },
  review:      { label: '검토',   bar: 'bg-orange-500' },
  completed:   { label: '완료',   bar: 'bg-green-500' },
};

function AddMilestoneForm({ projectId, onAdded }) {
  const [title,   setTitle]   = useState('');
  const [dueDate, setDueDate] = useState('');
  const [saving,  setSaving]  = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      await api.post(`/projects/${projectId}/milestones`, {
        title: title.trim(),
        due_date: dueDate || null,
      });
      setTitle('');
      setDueDate('');
      onAdded();
    } catch (e) { alert(e.message); }
    finally { setSaving(false); }
  };

  return (
    <form onSubmit={submit} className="flex gap-2 mt-3">
      <input
        className="input-base flex-1 text-sm"
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="마일스톤 제목"
      />
      <input
        type="date"
        className="input-base text-sm w-auto"
        value={dueDate}
        onChange={e => setDueDate(e.target.value)}
      />
      <button type="submit" className="btn-primary text-sm px-3" disabled={saving || !title.trim()}>
        {saving ? '...' : '추가'}
      </button>
    </form>
  );
}

export default function ProjectDetailPage() {
  const { id }    = useParams();
  const router    = useRouter();
  const [project, setProject]     = useState(null);
  const [milestones, setMsls]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [status,  setStatus]      = useState('');
  const [saving,  setSaving]      = useState(false);

  const load = async () => {
    try {
      const [pRes, mRes] = await Promise.all([
        api.get(`/projects/${id}`),
        api.get(`/projects/${id}/milestones`),
      ]);
      setProject(pRes.project);
      setStatus(pRes.project?.status || '');
      setMsls(mRes.milestones || []);
    } catch (e) {
      alert(e.message);
      router.push('/projects');
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [id]);

  const updateStatus = async (newStatus) => {
    setSaving(true);
    try {
      await api.put(`/projects/${id}`, { status: newStatus });
      setStatus(newStatus);
      setProject(p => ({ ...p, status: newStatus }));
    } catch (e) { alert(e.message); }
    finally { setSaving(false); }
  };

  const toggleMilestone = async (ms) => {
    const newStatus = ms.status === 'completed' ? 'pending' : 'completed';
    try {
      await api.put(`/milestones/${ms.id}`, { status: newStatus });
      load();
    } catch (e) { alert(e.message); }
  };

  if (loading) return <div className="text-center py-20 text-gray-400">로딩 중...</div>;
  if (!project) return null;

  const cfg    = STATUS_CONFIG[status] || {};
  const pct    = Number(project.progress ?? 0);
  const done   = milestones.filter(m => m.status === 'completed').length;
  const total  = milestones.length;

  return (
    <div className="space-y-4 max-w-2xl">
      {/* 헤더 */}
      <div className="flex items-center gap-2">
        <Link href="/projects" className="text-sm text-gray-500 hover:text-gray-700">← 프로젝트 목록</Link>
      </div>

      <div className="card space-y-4">
        <h1 className="text-xl font-bold text-gray-900">{project.name}</h1>

        {/* 상태 변경 */}
        <div>
          <label className="text-sm font-medium text-gray-700 block mb-1.5">상태</label>
          <div className="flex flex-wrap gap-2">
            {STATUS_OPTIONS.map(opt => (
              <button
                key={opt.value}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                  status === opt.value
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'border-gray-200 text-gray-600 hover:border-indigo-300'
                }`}
                onClick={() => updateStatus(opt.value)}
                disabled={saving || status === opt.value}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* 진행률 */}
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span className="text-gray-600">전체 진행률</span>
            <span className="font-medium">{pct}%</span>
          </div>
          <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${cfg.bar || 'bg-indigo-500'}`} style={{ width: `${pct}%` }} />
          </div>
          {total > 0 && <p className="text-xs text-gray-400 mt-1">{done}/{total} 마일스톤 완료</p>}
        </div>

        {project.end_date && (
          <p className="text-sm text-gray-500">📅 마감: {project.end_date.slice(0, 10)}</p>
        )}
      </div>

      {/* 마일스톤 */}
      <div className="card">
        <h2 className="font-semibold text-gray-800 mb-3">🏁 마일스톤</h2>

        {milestones.length === 0 ? (
          <p className="text-sm text-gray-400 py-2">마일스톤 없음</p>
        ) : (
          <div className="space-y-2">
            {milestones.map(ms => (
              <div
                key={ms.id}
                className={`flex items-center gap-3 p-3 rounded-lg border transition-colors cursor-pointer ${
                  ms.status === 'completed'
                    ? 'bg-green-50 border-green-200'
                    : 'border-gray-100 hover:border-indigo-200'
                }`}
                onClick={() => toggleMilestone(ms)}
              >
                <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 ${
                  ms.status === 'completed' ? 'bg-green-500 border-green-500' : 'border-gray-300'
                }`}>
                  {ms.status === 'completed' && <span className="text-white text-xs">✓</span>}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium ${ms.status === 'completed' ? 'line-through text-gray-400' : 'text-gray-800'}`}>
                    {ms.title}
                  </p>
                  {ms.due_date && (
                    <p className="text-xs text-gray-400">마감: {ms.due_date.slice(0, 10)}</p>
                  )}
                </div>
                {ms.status === 'completed' && ms.completed_at && (
                  <p className="text-xs text-green-600 shrink-0">
                    {new Date(ms.completed_at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        <AddMilestoneForm projectId={id} onAdded={load} />
      </div>
    </div>
  );
}
