'use client';
import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, LayoutDashboard, Users, Clock, DollarSign, FolderKanban, Calendar, BookOpen, CheckSquare, Settings, Bot, Save } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

const ICON_MAP = {
  dashboard:  LayoutDashboard,
  attendance: Clock,
  sales:      DollarSign,
  projects:   FolderKanban,
  schedules:  Calendar,
  journals:   BookOpen,
  employees:  Users,
  payroll:    DollarSign,
  approvals:  CheckSquare,
  settings:   Settings,
  ai:         Bot,
};

function normalizeEnabledMenus(enabledMenus, allMenus) {
  if (!Array.isArray(enabledMenus)) return new Set((allMenus || []).map(m => m.key));
  const mapped = enabledMenus.flatMap((key) => {
    switch (key) {
      case 'chat':
        return ['journals'];
      case 'documents':
        return ['schedules', 'journals', 'sales', 'projects'];
      case 'workforce':
        return ['employees', 'payroll'];
      default:
        return [key];
    }
  });
  return new Set(mapped);
}

export default function CompanyMenusPage() {
  const { id }     = useParams();
  const router     = useRouter();
  const { user }   = useAuth();

  const [company,   setCompany]   = useState(null);
  const [allMenus,  setAllMenus]  = useState([]);
  const [selected,  setSelected]  = useState(new Set());
  const [loading,   setLoading]   = useState(true);
  const [saving,    setSaving]    = useState(false);
  const [saved,     setSaved]     = useState(false);
  const [error,     setError]     = useState('');

  useEffect(() => {
    if (user && user.role !== 'master') router.push('/dashboard');
  }, [user, router]);

  useEffect(() => {
    if (!id) return;
    api.get(`/companies/${id}/menus`)
      .then(data => {
        setCompany(data.company);
        setAllMenus(data.allMenus);
        const keys = normalizeEnabledMenus(data.company.enabled_menus, data.allMenus);
        setSelected(keys);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  const toggle = (key, alwaysOn) => {
    if (alwaysOn) return;
    setSelected(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(allMenus.map(m => m.key)));
  const clearAll  = () => {
    // alwaysOn은 해제 불가
    setSelected(new Set(allMenus.filter(m => m.alwaysOn).map(m => m.key)));
  };

  const handleSave = async () => {
    setSaving(true); setError(''); setSaved(false);
    try {
      await api.put(`/companies/${id}/menus`, { enabled_menus: [...selected] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  if (user?.role !== 'master') return null;

  if (loading) {
    return <div className="text-center py-20 text-gray-400">로딩 중...</div>;
  }

  return (
    <div className="max-w-xl space-y-5">
      {/* 헤더 */}
      <div className="flex items-center gap-3">
        <Link href="/admin/companies" className="text-gray-400 hover:text-gray-600 transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-xl font-bold text-gray-900">메뉴 설정</h1>
          <p className="text-sm text-gray-500 mt-0.5">{company?.name}</p>
        </div>
        <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium ml-1">MASTER</span>
      </div>

      <div className="card space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-600">
            활성화할 메뉴를 선택하세요.
            <span className="text-gray-400 ml-1">(회색 항목은 항상 표시됩니다)</span>
          </p>
          <div className="flex gap-2 text-xs">
            <button onClick={selectAll} className="text-indigo-500 hover:text-indigo-700 font-medium">전체 선택</button>
            <span className="text-gray-300">|</span>
            <button onClick={clearAll}  className="text-gray-400 hover:text-gray-600 font-medium">전체 해제</button>
          </div>
        </div>

        <ul className="divide-y divide-gray-100">
          {allMenus.map(menu => {
            const Icon    = ICON_MAP[menu.key] || Settings;
            const checked = selected.has(menu.key);
            return (
              <li key={menu.key}>
                <label className={`flex items-center gap-3 py-3 px-1 ${menu.alwaysOn ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-gray-50 rounded-lg'}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={menu.alwaysOn}
                    onChange={() => toggle(menu.key, menu.alwaysOn)}
                    className="w-4 h-4 rounded accent-indigo-600"
                  />
                  <Icon className={`w-4 h-4 shrink-0 ${checked ? 'text-indigo-500' : 'text-gray-300'}`} />
                  <span className={`text-sm font-medium ${checked ? 'text-gray-800' : 'text-gray-400'}`}>
                    {menu.label}
                  </span>
                  {menu.alwaysOn && (
                    <span className="ml-auto text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">항상 표시</span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>

        {error && <p className="text-red-500 text-sm">{error}</p>}

        <div className="flex items-center justify-between pt-2 border-t">
          {saved
            ? <p className="text-sm text-green-600 font-medium">✅ 저장되었습니다</p>
            : <p className="text-xs text-gray-400">{selected.size}개 메뉴 활성화</p>
          }
          <button
            onClick={handleSave}
            disabled={saving}
            className="btn-primary flex items-center gap-2 text-sm"
          >
            <Save className="w-4 h-4" />
            {saving ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
