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

const MS_STATUS = [
  { value: 'pending',     label: '대기',   style: 'bg-gray-100 text-gray-600 hover:bg-gray-200' },
  { value: 'in_progress', label: '진행중', style: 'bg-blue-100 text-blue-700 hover:bg-blue-200' },
  { value: 'completed',   label: '완료',   style: 'bg-green-100 text-green-700 hover:bg-green-200' },
];

function MilestoneStatusBtn({ ms, onChange }) {
  const [loading, setLoading] = useState(false);

  const cycle = async () => {
    const order = ['pending', 'in_progress', 'completed'];
    const next = order[(order.indexOf(ms.status) + 1) % order.length];
    setLoading(true);
    try {
      await api.put(`/milestones/${ms.id}`, { status: next });
      onChange();
    } catch (e) { alert(e.message); }
    finally { setLoading(false); }
  };

  const cur = MS_STATUS.find(s => s.value === ms.status) || MS_STATUS[0];

  return (
    <button
      onClick={e => { e.stopPropagation(); cycle(); }}
      disabled={loading}
      className={`shrink-0 text-xs font-medium px-2.5 py-1 rounded-full transition-colors ${cur.style}`}
    >
      {loading ? '...' : cur.label}
    </button>
  );
}

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
  const [form, setForm] = useState({
    name: '',
    description: '',
    start_date: '',
    end_date: '',
  });

  const load = async () => {
    try {
      const [pRes, mRes] = await Promise.all([
        api.get(`/projects/${id}`),
        api.get(`/projects/${id}/milestones`),
      ]);
      setProject(pRes.project);
      setStatus(pRes.project?.status || '');
      setForm({
        name: pRes.project?.name || '',
        description: pRes.project?.description || '',
        start_date: pRes.project?.start_date?.slice(0, 10) || '',
        end_date: pRes.project?.end_date?.slice(0, 10) || '',
      });
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

  const saveProject = async () => {
    setSaving(true);
    try {
      const res = await api.put(`/projects/${id}`, {
        name: form.name,
        description: form.description,
        start_date: form.start_date || null,
        end_date: form.end_date || null,
      });
      setProject((prev) => ({ ...prev, ...res.project }));
      alert('프로젝트 정보를 저장했습니다.');
    } catch (e) { alert(e.message); }
    finally { setSaving(false); }
  };

  const deleteProject = async () => {
    if (!confirm('프로젝트를 삭제하시겠습니까?')) return;
    try {
      await api.delete(`/projects/${id}`);
      router.push('/projects');
    } catch (e) { alert(e.message); }
  };

  if (loading) return <div className="text-center py-20 text-gray-400">로딩 중...</div>;
  if (!project) return null;

  const cfg   = STATUS_CONFIG[status] || {};
  const pct   = Number(project.progress ?? 0);
  const done  = milestones.filter(m => m.status === 'completed').length;
  const total = milestones.length;

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-2">
        <Link href="/projects" className="text-sm text-gray-500 hover:text-gray-700">← 프로젝트 목록</Link>
      </div>

      <div className="card space-y-4">
        <h1 className="text-xl font-bold text-gray-900">{project.name}</h1>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-1 md:col-span-2">
            <span className="text-sm font-medium text-gray-700">프로젝트명</span>
            <input className="input-base" value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} />
          </label>
          <label className="space-y-1 md:col-span-2">
            <span className="text-sm font-medium text-gray-700">설명</span>
            <textarea className="input-base min-h-[88px]" value={form.description} onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))} />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium text-gray-700">시작일</span>
            <input type="date" className="input-base" value={form.start_date} onChange={(e) => setForm((prev) => ({ ...prev, start_date: e.target.value }))} />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium text-gray-700">마감일</span>
            <input type="date" className="input-base" value={form.end_date} onChange={(e) => setForm((prev) => ({ ...prev, end_date: e.target.value }))} />
          </label>
        </div>

        {/* 프로젝트 상태 변경 */}
        <div>
          <label className="text-sm font-medium text-gray-700 block mb-1.5">프로젝트 상태</label>
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

        <div className="flex flex-wrap gap-2 pt-2">
          <button type="button" className="btn-primary" onClick={saveProject} disabled={saving || !form.name.trim()}>
            {saving ? '저장 중...' : '프로젝트 저장'}
          </button>
          <button type="button" className="btn-danger" onClick={deleteProject} disabled={saving}>
            삭제
          </button>
        </div>
      </div>

      {/* 마일스톤 */}
      <div className="card">
        <h2 className="font-semibold text-gray-800 mb-3">🏁 마일스톤</h2>

        {milestones.length === 0 ? (
          <p className="text-sm text-gray-400 py-2">마일스톤 없음 — 아래에서 추가하세요</p>
        ) : (
          <div className="space-y-2">
            {milestones.map(ms => (
              <div
                key={ms.id}
                className={`flex items-center gap-3 p-3 rounded-lg border ${
                  ms.status === 'completed'
                    ? 'bg-green-50 border-green-200'
                    : ms.status === 'in_progress'
                    ? 'bg-blue-50 border-blue-200'
                    : 'border-gray-100'
                }`}
              >
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
                <MilestoneStatusBtn ms={ms} onChange={load} />
              </div>
            ))}
          </div>
        )}

        <AddMilestoneForm projectId={id} onAdded={load} />
      </div>
    </div>
  );
}
