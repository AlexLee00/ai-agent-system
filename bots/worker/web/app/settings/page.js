'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

export default function SettingsPage() {
  const { user } = useAuth();
  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
  const [msg, setMsg]       = useState('');
  const [saving, setSaving] = useState(false);

  const handlePwChange = async (e) => {
    e.preventDefault();
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
      <h1 className="text-xl font-bold text-gray-900">⚙️ 설정</h1>

      {/* 내 정보 */}
      <div className="card space-y-3">
        <h2 className="font-semibold text-gray-800">내 정보</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div><span className="text-gray-500">이름</span><p className="font-medium">{user?.name || '-'}</p></div>
          <div><span className="text-gray-500">아이디</span><p className="font-medium">{user?.username}</p></div>
          <div><span className="text-gray-500">역할</span><span className={`badge-${user?.role}`}>{user?.role}</span></div>
          <div><span className="text-gray-500">이메일</span><p className="font-medium">{user?.email || '-'}</p></div>
        </div>
      </div>

      {/* 비밀번호 변경 */}
      <div className="card">
        <h2 className="font-semibold text-gray-800 mb-4">비밀번호 변경</h2>
        <form onSubmit={handlePwChange} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">현재 비밀번호</label>
            <input type="password" className="input-base" value={pwForm.current} onChange={e=>setPwForm(p=>({...p,current:e.target.value}))} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">새 비밀번호</label>
            <input type="password" className="input-base" value={pwForm.next}    onChange={e=>setPwForm(p=>({...p,next:e.target.value}))} />
            <p className="text-xs text-gray-400 mt-1">8자 이상, 대/소문자/숫자/특수문자 중 3가지 이상</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">새 비밀번호 확인</label>
            <input type="password" className="input-base" value={pwForm.confirm} onChange={e=>setPwForm(p=>({...p,confirm:e.target.value}))} />
          </div>
          {msg && <p className={`text-sm ${msg.startsWith('✅') ? 'text-green-600' : 'text-red-500'}`}>{msg}</p>}
          <button type="submit" className="btn-primary w-full" disabled={saving}>{saving ? '변경 중...' : '비밀번호 변경'}</button>
        </form>
      </div>
    </div>
  );
}
