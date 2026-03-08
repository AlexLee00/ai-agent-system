'use client';
import { useState, useEffect, useMemo } from 'react';
import { api } from '@/lib/api';

const TYPE_CONFIG = {
  meeting:  { label: '미팅',     color: 'bg-blue-100 text-blue-700',   dot: 'bg-blue-500' },
  task:     { label: '업무',     color: 'bg-indigo-100 text-indigo-700', dot: 'bg-indigo-500' },
  event:    { label: '이벤트',   color: 'bg-pink-100 text-pink-700',   dot: 'bg-pink-500' },
  reminder: { label: '리마인더', color: 'bg-yellow-100 text-yellow-700', dot: 'bg-yellow-500' },
};

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtDatetime(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

// ── 캘린더 뷰 ──────────────────────────────────────────────────────

function CalendarView({ year, month, schedules }) {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

  // 날짜별 일정 맵
  const byDate = useMemo(() => {
    const m = {};
    for (const s of schedules) {
      if (!s.start_time) continue;
      const d = s.start_time.slice(0, 10);
      if (!m[d]) m[d] = [];
      m[d].push(s);
    }
    return m;
  }, [schedules]);

  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div className="card">
      <div className="grid grid-cols-7 mb-2">
        {WEEKDAYS.map((d, i) => (
          <div key={i} className={`text-xs text-center font-medium py-1 ${i === 0 ? 'text-red-500' : i === 6 ? 'text-blue-500' : 'text-gray-500'}`}>{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px bg-gray-100">
        {cells.map((d, i) => {
          if (!d) return <div key={`e-${i}`} className="bg-white min-h-[72px]" />;
          const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
          const dayEvts = byDate[dateStr] || [];
          const isToday = dateStr === todayStr;
          const dow = (firstDay + d - 1) % 7;
          return (
            <div key={dateStr} className="bg-white min-h-[72px] p-1">
              <div className={`text-xs font-medium mb-1 w-6 h-6 flex items-center justify-center rounded-full ${
                isToday ? 'bg-indigo-600 text-white' : dow === 0 ? 'text-red-500' : dow === 6 ? 'text-blue-500' : 'text-gray-700'
              }`}>{d}</div>
              <div className="space-y-0.5">
                {dayEvts.slice(0, 3).map(s => {
                  const cfg = TYPE_CONFIG[s.type] || {};
                  return (
                    <div key={s.id} className={`text-xs px-1 py-0.5 rounded truncate ${cfg.color || 'bg-gray-100 text-gray-600'}`}>
                      {fmtTime(s.start_time)} {s.title}
                    </div>
                  );
                })}
                {dayEvts.length > 3 && <div className="text-xs text-gray-400 px-1">+{dayEvts.length - 3}건</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── 리스트 뷰 ─────────────────────────────────────────────────────

function ListView({ schedules, onDelete }) {
  if (!schedules.length) return (
    <div className="text-center py-16 text-gray-400">
      <p className="text-4xl mb-3">📅</p>
      <p className="text-sm">이달 일정 없음</p>
    </div>
  );

  return (
    <div className="card space-y-2">
      {schedules.map(s => {
        const cfg = TYPE_CONFIG[s.type] || {};
        return (
          <div key={s.id} className="flex items-start gap-3 p-3 rounded-lg border border-gray-100 hover:border-indigo-200 transition-colors group">
            <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${cfg.dot || 'bg-gray-400'}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs px-1.5 py-0.5 rounded ${cfg.color || 'bg-gray-100'}`}>{cfg.label || s.type}</span>
                <p className="text-sm font-medium text-gray-900">{s.title}</p>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">{fmtDatetime(s.start_time)}{s.location ? ` · ${s.location}` : ''}</p>
            </div>
            <button
              className="text-xs text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              onClick={() => onDelete(s.id)}
            >✕</button>
          </div>
        );
      })}
    </div>
  );
}

// ── 일정 추가 모달 ────────────────────────────────────────────────

function AddModal({ onClose, onAdded }) {
  const [form, setForm] = useState({
    title: '',
    type: 'task',
    start_time: new Date().toISOString().slice(0, 16),
    location: '',
  });
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      await api.post('/schedules', {
        ...form,
        start_time: new Date(form.start_time).toISOString(),
      });
      onAdded();
      onClose();
    } catch (e) { alert(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
        <h3 className="font-bold text-gray-900 mb-4">📅 일정 추가</h3>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">유형</label>
            <select className="input-base w-full" value={form.type} onChange={e => set('type', e.target.value)}>
              {Object.entries(TYPE_CONFIG).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">제목</label>
            <input className="input-base w-full" value={form.title} onChange={e => set('title', e.target.value)} placeholder="일정 제목" autoFocus />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">시작 일시</label>
            <input type="datetime-local" className="input-base w-full" value={form.start_time} onChange={e => set('start_time', e.target.value)} />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 block mb-1">장소 (선택)</label>
            <input className="input-base w-full" value={form.location} onChange={e => set('location', e.target.value)} placeholder="장소" />
          </div>
          <div className="flex gap-2 pt-2">
            <button type="button" className="btn-secondary flex-1" onClick={onClose}>취소</button>
            <button type="submit" className="btn-primary flex-1" disabled={saving || !form.title.trim()}>
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── 메인 페이지 ───────────────────────────────────────────────────

export default function SchedulesPage() {
  const now = new Date();
  const [year,  setYear]  = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth()); // 0-based
  const [view,  setView]  = useState('calendar'); // 'calendar' | 'list'
  const [schedules, setSchedules] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [showAdd,   setShowAdd]   = useState(false);

  const yearMonth = `${year}-${String(month + 1).padStart(2, '0')}`;

  const load = () => {
    setLoading(true);
    api.get(`/schedules?year_month=${yearMonth}`)
      .then(d => setSchedules(d.schedules || []))
      .catch(() => setSchedules([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [yearMonth]);

  const prevMonth = () => {
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (month === 11) { setYear(y => y + 1); setMonth(0); }
    else setMonth(m => m + 1);
  };

  const deleteSchedule = async (scheduleId) => {
    if (!confirm('일정을 삭제하시겠습니까?')) return;
    try {
      await api.delete(`/schedules/${scheduleId}`);
      load();
    } catch (e) { alert(e.message); }
  };

  // 리스트뷰용 정렬
  const sorted = [...schedules].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">📅 일정 관리</h1>
        <button className="btn-primary text-sm" onClick={() => setShowAdd(true)}>+ 일정 추가</button>
      </div>

      {/* 월 내비 + 뷰 전환 */}
      <div className="flex items-center gap-3">
        <button className="btn-secondary px-2 py-1 text-sm" onClick={prevMonth}>‹</button>
        <span className="font-semibold text-gray-800 min-w-[80px] text-center">{year}년 {month + 1}월</span>
        <button className="btn-secondary px-2 py-1 text-sm" onClick={nextMonth}>›</button>
        <div className="ml-auto flex gap-1 bg-gray-100 p-1 rounded-lg">
          {[{ k: 'calendar', label: '캘린더' }, { k: 'list', label: '목록' }].map(v => (
            <button
              key={v.k}
              className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                view === v.k ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'
              }`}
              onClick={() => setView(v.k)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-center py-16 text-gray-400">로딩 중...</div>
      ) : view === 'calendar' ? (
        <CalendarView year={year} month={month} schedules={schedules} />
      ) : (
        <ListView schedules={sorted} onDelete={deleteSchedule} />
      )}

      {showAdd && <AddModal onClose={() => setShowAdd(false)} onAdded={load} />}
    </div>
  );
}
