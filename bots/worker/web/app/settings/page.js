'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { validatePassword } from '@/lib/password-validator';
import PasswordRuleChecker from '@/components/PasswordRuleChecker';

export default function SettingsPage() {
  const { user } = useAuth();
  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
  const [msg, setMsg]       = useState('');
  const [saving, setSaving] = useState(false);

  const validation   = validatePassword(pwForm.next);
  const confirmMatch = pwForm.confirm ? pwForm.next === pwForm.confirm : null;

  const handlePwChange = async (e) => {
    e.preventDefault();
    const v = validatePassword(pwForm.next);
    if (!v.isValid) { setMsg('비밀번호 정책을 충족하지 않습니다.'); return; }
    if (pwForm.next !== pwForm.confirm) { setMsg('새 비밀번호가 일치하지 않습니다.'); return; }
    setSaving(true); setMsg('');
    try {
      await api.post('/auth/change-password', {
        current_password: pwForm.current,
        new_password:     pwForm.next,
      });
      setMsg('✅ 비밀번호가 변경되었습니다.');
      setPwForm({ current: '', next: '', confirm: '' });
    } catch (err) { setMsg(`❌ ${err.message}`); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-6 max-w-lg">
      <div className="card bg-gradient-to-br from-white to-slate-100/80">
        <h1 className="text-xl font-bold text-slate-900">⚙️ 개인정보 및 비밀번호 관리</h1>
        <p className="text-sm text-slate-500 mt-2">계정 정보 확인과 비밀번호 변경을 한 곳에서 관리합니다.</p>
      </div>

      {/* 내 정보 */}
      <div className="card space-y-3">
        <h2 className="font-semibold text-slate-800">내 정보</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div><span className="text-slate-500">이름</span><p className="font-medium">{user?.name || '-'}</p></div>
          <div><span className="text-slate-500">아이디</span><p className="font-medium">{user?.username}</p></div>
          <div><span className="text-slate-500">역할</span><span className={`badge-${user?.role}`}>{user?.role}</span></div>
          <div><span className="text-slate-500">이메일</span><p className="font-medium">{user?.email || '-'}</p></div>
        </div>
      </div>

      {/* 비밀번호 변경 */}
      <div className="card">
        <h2 className="font-semibold text-slate-800 mb-4">비밀번호 변경</h2>
        <form onSubmit={handlePwChange} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">현재 비밀번호</label>
            <input type="password" className="input-base" value={pwForm.current}
              onChange={e => setPwForm(p => ({ ...p, current: e.target.value }))} />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">새 비밀번호</label>
            <input type="password" className="input-base" value={pwForm.next}
              onChange={e => setPwForm(p => ({ ...p, next: e.target.value }))} />
            <PasswordRuleChecker password={pwForm.next} />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">새 비밀번호 확인</label>
            <input type="password" className="input-base" value={pwForm.confirm}
              onChange={e => setPwForm(p => ({ ...p, confirm: e.target.value }))} />
            {confirmMatch === true  && <p className="text-xs text-green-600 mt-1">✅ 비밀번호 일치</p>}
            {confirmMatch === false && <p className="text-xs text-red-500 mt-1">❌ 비밀번호가 일치하지 않습니다</p>}
          </div>
          {msg && <p className={`text-sm ${msg.startsWith('✅') ? 'text-green-600' : 'text-red-500'}`}>{msg}</p>}
          <button type="submit" className="btn-primary w-full"
            disabled={saving || !validation.isValid || pwForm.next !== pwForm.confirm}>
            {saving ? '변경 중...' : '비밀번호 변경'}
          </button>
        </form>
      </div>
    </div>
  );
}
