'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';

export default function LoginPage() {
  const { login } = useAuth();
  const router    = useRouter();
  const [form,   setForm]   = useState({ username: '', password: '' });
  const [error,  setError]  = useState('');
  const [loading, setLoading] = useState(false);
  const [showPw,  setShowPw]  = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.username || !form.password) { setError('아이디와 비밀번호를 입력하세요.'); return; }
    setLoading(true); setError('');
    try {
      await login(form.username, form.password);
      router.push('/dashboard');
    } catch (err) {
      setError(err.message || '아이디 또는 비밀번호가 올바르지 않습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.95),_rgba(241,245,249,0.9)_45%,_rgba(226,232,240,0.9))] flex items-center justify-center p-4">
      <div className="bg-white/95 backdrop-blur-sm rounded-[1.75rem] shadow-xl border border-slate-200 w-full max-w-sm p-8">
        {/* 로고 */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-[1.5rem] bg-slate-900 text-white mx-auto mb-4 flex items-center justify-center text-3xl">W</div>
          <h1 className="text-2xl font-semibold text-slate-900">워커 업무 운영</h1>
          <p className="text-slate-500 text-sm mt-2">AI와 함께 업무를 대화형으로 운영하는 관리 시스템</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">아이디</label>
            <input
              type="text"
              autoComplete="username"
              className="input-base"
              placeholder="아이디 입력"
              value={form.username}
              onChange={e => setForm(p => ({ ...p, username: e.target.value }))}
              disabled={loading}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">비밀번호</label>
            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'}
                autoComplete="current-password"
                className="input-base pr-10"
                placeholder="비밀번호 입력"
                value={form.password}
                onChange={e => setForm(p => ({ ...p, password: e.target.value }))}
                disabled={loading}
              />
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setShowPw(v => !v)}
                className="absolute inset-y-0 right-3 flex items-center text-slate-400 hover:text-slate-600"
              >
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {error && (
            <div className="bg-rose-50 border border-rose-200 text-rose-600 text-sm rounded-2xl px-4 py-3">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full text-base mt-2 flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                로그인 중...
              </>
            ) : '로그인'}
          </button>
        </form>
      </div>
    </div>
  );
}
