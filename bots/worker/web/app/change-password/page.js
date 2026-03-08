'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { api } from '@/lib/api';

export default function ChangePasswordPage() {
  const { user, refreshUser } = useAuth();
  const router = useRouter();
  const [form, setForm]   = useState({ current_password: '', new_password: '', confirm: '' });
  const [error, setError]  = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (form.new_password !== form.confirm) { setError('새 비밀번호가 일치하지 않습니다.'); return; }
    if (form.new_password.length < 8) { setError('비밀번호는 8자 이상이어야 합니다.'); return; }
    setSaving(true); setError('');
    try {
      await api.post('/auth/change-password', {
        current_password: form.current_password,
        new_password: form.new_password,
      });
      await refreshUser();
      router.push('/dashboard');
    } catch (err) {
      setError(err.message || '비밀번호 변경에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-8">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-3">
            <KeyRound className="w-8 h-8 text-indigo-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">비밀번호 변경</h1>
          {user?.must_change_pw && (
            <p className="text-sm text-amber-600 mt-2 bg-amber-50 rounded-lg px-3 py-2">
              첫 로그인 시 비밀번호를 변경해야 합니다
            </p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">현재 비밀번호</label>
            <input
              type="password"
              className="input-base"
              autoComplete="current-password"
              value={form.current_password}
              onChange={e => setForm(p => ({ ...p, current_password: e.target.value }))}
              disabled={saving}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">새 비밀번호</label>
            <input
              type="password"
              className="input-base"
              autoComplete="new-password"
              placeholder="8자 이상"
              value={form.new_password}
              onChange={e => setForm(p => ({ ...p, new_password: e.target.value }))}
              disabled={saving}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">새 비밀번호 확인</label>
            <input
              type="password"
              className="input-base"
              autoComplete="new-password"
              value={form.confirm}
              onChange={e => setForm(p => ({ ...p, confirm: e.target.value }))}
              disabled={saving}
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-600 text-sm rounded-lg px-4 py-3">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            {saving ? (
              <><Loader2 className="w-4 h-4 animate-spin" />변경 중...</>
            ) : '비밀번호 변경'}
          </button>

          {!user?.must_change_pw && (
            <button
              type="button"
              className="btn-secondary w-full"
              onClick={() => router.back()}
            >
              취소
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
