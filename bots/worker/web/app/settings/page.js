'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { validatePassword } from '@/lib/password-validator';
import PasswordRuleChecker from '@/components/PasswordRuleChecker';

export default function SettingsPage() {
  const { user, refreshUser } = useAuth();
  const canEditProfile = ['admin', 'master'].includes(user?.role);
  const [profileForm, setProfileForm] = useState({ name: '', email: '', telegram_id: '' });
  const [profileMsg, setProfileMsg] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);
  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
  const [msg, setMsg]       = useState('');
  const [saving, setSaving] = useState(false);
  const [aiPolicy, setAiPolicy] = useState(user?.ai_policy || null);
  const [aiMsg, setAiMsg] = useState('');
  const [aiSaving, setAiSaving] = useState(false);

  const validation   = validatePassword(pwForm.next);
  const confirmMatch = pwForm.confirm ? pwForm.next === pwForm.confirm : null;

  const llmModeLabels = {
    off: 'OFF',
    assist: '보조',
    full: 'FULL',
  };

  useEffect(() => {
    setProfileForm({
      name: user?.name || '',
      email: user?.email || '',
      telegram_id: user?.telegram_id || '',
    });
  }, [user?.name, user?.email, user?.telegram_id]);

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

  const loadAiPolicy = async () => {
    try {
      const data = await api.get('/settings/ai-policy');
      setAiPolicy(data.ai_policy || null);
    } catch {
      setAiPolicy(user?.ai_policy || null);
    }
  };

  useEffect(() => {
    if (user?.ai_policy) {
      setAiPolicy(user.ai_policy);
      return;
    }
    loadAiPolicy();
  }, [user?.ai_policy]);

  const handleLlmModeChange = async (nextMode) => {
    setAiSaving(true);
    setAiMsg('');
    try {
      const data = await api.put('/settings/ai-policy', { llm_mode: nextMode });
      setAiPolicy(data.ai_policy || null);
      await refreshUser();
      setAiMsg('✅ AI 보조 모드가 변경되었습니다.');
    } catch (err) {
      setAiMsg(`❌ ${err.message}`);
    } finally {
      setAiSaving(false);
    }
  };

  const handleProfileSave = async (e) => {
    e.preventDefault();
    if (!canEditProfile) return;
    setProfileSaving(true);
    setProfileMsg('');
    try {
      await api.put('/settings/profile', {
        name: profileForm.name,
        email: profileForm.email,
        telegram_id: profileForm.telegram_id,
      });
      await refreshUser();
      setProfileMsg('✅ 개인정보를 수정했습니다.');
    } catch (err) {
      setProfileMsg(`❌ ${err.message}`);
    } finally {
      setProfileSaving(false);
    }
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

      <div className="card">
        <div className="mb-4">
          <h2 className="font-semibold text-slate-800">개인정보 수정</h2>
          <p className="text-sm text-slate-500 mt-1">
            {canEditProfile
              ? '관리자와 마스터는 이름, 이메일, 텔레그램 ID를 수정할 수 있습니다.'
              : '멤버 계정은 개인정보를 직접 수정할 수 없습니다. 비밀번호만 변경할 수 있습니다.'}
          </p>
        </div>

        <form onSubmit={handleProfileSave} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">이름</label>
            <input
              className="input-base"
              value={profileForm.name}
              onChange={(e) => setProfileForm((prev) => ({ ...prev, name: e.target.value }))}
              disabled={!canEditProfile || profileSaving}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">이메일</label>
            <input
              type="email"
              className="input-base"
              value={profileForm.email}
              onChange={(e) => setProfileForm((prev) => ({ ...prev, email: e.target.value }))}
              disabled={!canEditProfile || profileSaving}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">텔레그램 ID</label>
            <input
              className="input-base"
              value={profileForm.telegram_id}
              onChange={(e) => setProfileForm((prev) => ({ ...prev, telegram_id: e.target.value }))}
              disabled={!canEditProfile || profileSaving}
            />
          </div>
          {profileMsg && <p className={`text-sm ${profileMsg.startsWith('✅') ? 'text-green-600' : 'text-red-500'}`}>{profileMsg}</p>}
          <button
            type="submit"
            className="btn-primary w-full"
            disabled={!canEditProfile || profileSaving || !profileForm.name.trim()}
          >
            {profileSaving ? '저장 중...' : '개인정보 저장'}
          </button>
        </form>
      </div>

      <div className="card space-y-4">
        <div>
          <h2 className="font-semibold text-slate-800">AI 입력 모드</h2>
          <p className="text-sm text-slate-500 mt-1">권한에 따라 다른 프롬프트 화면과 확인 정책이 적용됩니다.</p>
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-slate-500">UI 모드</span>
            <p className="font-medium">
              {aiPolicy?.ui_mode === 'prompt_only'
                ? '프롬프트 전용'
                : aiPolicy?.ui_mode === 'prompt_plus_dashboard'
                  ? '프롬프트 + 현황'
                  : '마스터 콘솔'}
            </p>
          </div>
          <div>
            <span className="text-slate-500">확인 정책</span>
            <p className="font-medium">{aiPolicy?.confirmation_mode === 'optional' ? '선택 확인' : '결과 확인 필수'}</p>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
          <p className="text-xs text-slate-500">현재 LLM 모드</p>
          <p className="text-lg font-semibold text-slate-900 mt-1">{llmModeLabels[aiPolicy?.llm_mode] || '-'}</p>
          <p className="text-xs text-slate-500 mt-2">
            {aiPolicy?.source === 'master_fixed'
              ? '마스터 기본 정책이 적용되고 있습니다.'
              : aiPolicy?.source === 'user_override'
                ? '개인 override 정책이 적용되고 있습니다.'
                : '업체 기본 정책이 적용되고 있습니다.'}
          </p>
        </div>

        {aiPolicy?.can_toggle_llm ? (
          <div className="space-y-3">
            <p className="text-sm font-medium text-slate-700">LLM 보조 모드 변경</p>
            <div className="grid grid-cols-3 gap-2">
              {Object.entries(llmModeLabels)
                .filter(([key]) => aiPolicy?.role_profile === 'master' || key !== 'full')
                .map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    disabled={aiSaving || aiPolicy?.llm_mode === key}
                    onClick={() => handleLlmModeChange(key)}
                    className={`rounded-xl border px-3 py-2 text-sm font-medium ${
                      aiPolicy?.llm_mode === key
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-300 bg-white text-slate-700'
                    }`}
                  >
                    {label}
                  </button>
                ))}
            </div>
            <p className="text-xs text-slate-500">관리자/마스터만 이 설정을 변경할 수 있습니다.</p>
            {aiMsg && <p className={`text-sm ${aiMsg.startsWith('✅') ? 'text-green-600' : 'text-red-500'}`}>{aiMsg}</p>}
          </div>
        ) : (
          <p className="text-xs text-slate-500">현재 계정은 AI 보조 모드를 직접 변경할 수 없습니다.</p>
        )}
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
