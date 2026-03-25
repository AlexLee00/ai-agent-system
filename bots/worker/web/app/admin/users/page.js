'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { UserCog } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import AdminQuickNav from '@/components/AdminQuickNav';
import AdminPageHero from '@/components/AdminPageHero';
import AdminQuickFlowGrid from '@/components/AdminQuickFlowGrid';
import DataTable from '@/components/DataTable';
import Modal from '@/components/Modal';
import { useOperationsLoader } from '@/lib/use-operations-loader';

const ROLE_CONFIG = {
  master: { label: '마스터', cls: 'bg-red-100 text-red-700' },
  admin:  { label: '관리자', cls: 'bg-blue-100 text-blue-700' },
  member: { label: '멤버',   cls: 'bg-gray-100 text-gray-600' },
};

const EMPTY_FORM = {
  username: '', password: '', name: '', role: 'member',
  company_id: '', email: '', telegram_id: '',
};

export default function AdminUsersPage() {
  const { user, loading: authLoading } = useAuth();
  const router   = useRouter();

  const [users,      setUsers]      = useState([]);
  const [companies,  setCompanies]  = useState([]);
  const [filterCo,   setFilterCo]   = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [modal,      setModal]      = useState(false);
  const [resetModal, setResetModal] = useState(false);
  const [form,       setForm]       = useState(EMPTY_FORM);
  const [editId,     setEditId]     = useState(null);
  const [resetId,    setResetId]    = useState(null);
  const [resetPw,    setResetPw]    = useState('');
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState('');
  const { loading, loadError, setLoadError, runLoad } = useOperationsLoader(true);
  const quickFlows = [
    {
      title: '권한 분포 점검',
      body: '관리자/멤버 비중과 최근 로그인 현황을 바로 질의합니다.',
      promptHref: '/dashboard?prompt=' + encodeURIComponent('현재 사용자 권한 분포와 최근 로그인 현황을 요약해줘'),
      route: '/admin/users',
    },
    {
      title: '연동 누락 사용자 찾기',
      body: '텔레그램 미연동, 비밀번호 변경 필요 사용자를 빠르게 찾습니다.',
      promptHref: '/dashboard?prompt=' + encodeURIComponent('텔레그램 미연동 또는 비밀번호 변경이 필요한 사용자를 요약해줘'),
      route: '/admin/users',
    },
  ];

  useEffect(() => {
    if (user && user.role !== 'master') router.push('/dashboard');
  }, [user, router]);

  const loadAll = (co = filterCo, role = filterRole) => {
    return runLoad(async () => {
      const qs = new URLSearchParams();
      if (co) qs.set('company_id', co);
      if (role) qs.set('role', role);
      const q = qs.toString() ? `?${qs}` : '';
      const [u, c] = await Promise.allSettled([
        api.get(`/users${q}`),
        api.get('/companies'),
      ]);
      if (u.status === 'fulfilled') setUsers(u.value.users || []);
      else setUsers([]);

      if (c.status === 'fulfilled') setCompanies(c.value.companies || []);
      else setCompanies([]);

      const firstFailure = [u, c].find((result) => result.status === 'rejected');
      if (firstFailure) {
        setLoadError(firstFailure.reason?.message || '사용자 데이터를 불러오지 못했습니다.');
      }
    });
  };

  useEffect(() => { loadAll(); }, [authLoading, user?.id]);

  const companyName = (id) => companies.find(c => c.id === id)?.name || id || '-';

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const openNew = () => {
    setForm(EMPTY_FORM); setEditId(null); setError(''); setModal(true);
  };
  const openEdit = (u) => {
    setForm({
      username: u.username || '', password: '',
      name: u.name || '', role: u.role || 'member',
      company_id: u.company_id || '', email: u.email || '',
      telegram_id: u.telegram_id || '',
    });
    setEditId(u.id); setError(''); setModal(true);
  };
  const openReset = (u) => { setResetId(u.id); setResetPw(''); setError(''); setResetModal(true); };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.name.trim())    { setError('이름은 필수입니다.'); return; }
    if (!editId && !form.username.trim()) { setError('아이디는 필수입니다.'); return; }
    if (!editId && !form.password)        { setError('비밀번호는 필수입니다.'); return; }
    if (!editId && !form.company_id)      { setError('업체를 선택해주세요.'); return; }
    setSaving(true); setError('');
    try {
      if (editId) {
        await api.put(`/users/${editId}`, {
          name: form.name, email: form.email || null,
          telegram_id: form.telegram_id || null,
        });
      } else {
        await api.post('/users', {
          username: form.username, password: form.password,
          name: form.name, role: form.role,
          company_id: form.company_id, email: form.email || null,
          telegram_id: form.telegram_id || null,
        });
      }
      setModal(false); loadAll();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    if (!resetPw) { setError('임시 비밀번호를 입력하세요.'); return; }
    setSaving(true); setError('');
    try {
      await api.post(`/users/${resetId}/reset-pw`, { new_password: resetPw });
      setResetModal(false);
      alert('비밀번호가 초기화되었습니다. 사용자는 다음 로그인 시 변경해야 합니다.');
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (u) => {
    if (u.id === user.id) { alert('자기 자신은 삭제할 수 없습니다.'); return; }
    if (!confirm(`"${u.name}" 사용자를 비활성화하시겠습니까?`)) return;
    await api.delete(`/users/${u.id}`).catch(e => alert(e.message));
    loadAll();
  };

  const columns = [
    { key: 'name',         label: '이름' },
    { key: 'username',     label: '아이디',   render: v => <span className="font-mono text-sm">{v}</span> },
    { key: 'role',         label: '역할',     render: v => {
      const cfg = ROLE_CONFIG[v] || { label: v, cls: 'bg-gray-100 text-gray-500' };
      return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cfg.cls}`}>{cfg.label}</span>;
    }},
    { key: 'company_id',   label: '소속 업체', render: v => companyName(v) },
    { key: 'telegram_id',  label: '텔레그램',  render: v => v ? <span className="text-green-600 font-medium">✅ 연동됨</span> : <span className="text-gray-400">➖ 미연동</span> },
    { key: 'must_change_pw', label: 'PW 상태', render: v => v ? <span className="text-orange-500 text-xs font-medium">🔑 변경필요</span> : '-' },
    { key: 'last_login_at', label: '마지막 로그인', render: v => v ? new Date(v).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-' },
  ];

  const emptyNode = (
    <div className="text-center py-12">
      <p className="text-4xl mb-3">👤</p>
      <p className="text-gray-500 mb-4">조건에 맞는 사용자가 없습니다</p>
      <button onClick={openNew} className="btn-primary text-sm">+ 사용자 등록하기</button>
    </div>
  );

  if (user?.role !== 'master') return null;

  return (
    <div className="space-y-4">
      <AdminQuickNav />
      <AdminPageHero
        title="사용자 관리"
        badge="MASTER"
        tone="indigo"
        description="권한 분포, 소속 업체, 텔레그램 연동 상태를 보며 사용자 계정을 운영합니다."
        stats={[
          { label: '조회 사용자', value: users.length || 0, caption: '필터 기준' },
          { label: '업체 수', value: companies.length || 0, caption: '등록 업체 기준' },
        ]}
      />

      {loadError ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {loadError}
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-slate-600">
          <UserCog className="h-5 w-5 text-indigo-600" />
          <p className="text-sm font-medium">사용자 운영 작업</p>
        </div>
        <button className="btn-primary text-sm" onClick={openNew}>+ 사용자 등록</button>
      </div>

      {/* 필터 */}
      <div className="flex flex-wrap gap-2">
        <select
          className="input-base w-auto text-sm"
          value={filterCo}
          onChange={e => { setFilterCo(e.target.value); loadAll(e.target.value, filterRole); }}
        >
          <option value="">전체 업체</option>
          {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select
          className="input-base w-auto text-sm"
          value={filterRole}
          onChange={e => { setFilterRole(e.target.value); loadAll(filterCo, e.target.value); }}
        >
          <option value="">전체 역할</option>
          <option value="master">마스터</option>
          <option value="admin">관리자</option>
          <option value="member">멤버</option>
        </select>
        {(filterCo || filterRole) && (
          <button className="btn-secondary text-sm" onClick={() => { setFilterCo(''); setFilterRole(''); loadAll('', ''); }}>
            초기화
          </button>
        )}
        <span className="ml-auto text-sm text-gray-500 self-center">{users.length}명</span>
      </div>

      <AdminQuickFlowGrid
        items={quickFlows.map((item) => ({
          title: item.title,
          body: item.body,
          onPromptFill: () => router.push(item.promptHref),
          onSecondary: () => router.push(item.route),
        }))}
      />

      <div className="card overflow-x-auto">
        {loading ? (
          <p className="text-center py-10 text-gray-400">로딩 중...</p>
        ) : (
          <DataTable
              pageSize={10}
            columns={columns}
            data={users}
            emptyNode={emptyNode}
            actions={row => (
              <div className="flex gap-1">
                <button className="btn-secondary text-xs px-2 py-1" onClick={() => openEdit(row)}>수정</button>
                <button className="btn-secondary text-xs px-2 py-1" onClick={() => openReset(row)}>PW초기화</button>
                {row.id !== user.id && (
                  <button className="btn-danger text-xs px-2 py-1" onClick={() => handleDelete(row)}>삭제</button>
                )}
              </div>
            )}
          />
        )}
      </div>

      {/* 사용자 등록/수정 모달 */}
      <Modal open={modal} onClose={() => setModal(false)} title={editId ? '사용자 수정' : '사용자 등록'}>
        <form onSubmit={handleSave} className="space-y-3">
          {!editId && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">아이디 *</label>
                  <input className="input-base font-mono" value={form.username}
                    onChange={e => set('username', e.target.value)} placeholder="영문/숫자/_" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">임시 비밀번호 *</label>
                  <input className="input-base" type="password" value={form.password}
                    onChange={e => set('password', e.target.value)} placeholder="8자 이상" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">소속 업체 *</label>
                <select className="input-base w-full" value={form.company_id}
                  onChange={e => set('company_id', e.target.value)}>
                  <option value="">업체 선택</option>
                  {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            </>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">이름 *</label>
              <input className="input-base" value={form.name}
                onChange={e => set('name', e.target.value)} placeholder="실명" />
            </div>
            {!editId && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">역할</label>
                <select className="input-base" value={form.role}
                  onChange={e => set('role', e.target.value)}>
                  <option value="member">멤버</option>
                  <option value="admin">관리자</option>
                </select>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">이메일</label>
            <input className="input-base w-full" type="email" value={form.email}
              onChange={e => set('email', e.target.value)} placeholder="example@company.com" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">텔레그램 ID (chat_id)</label>
            <input className="input-base w-full font-mono" type="number" value={form.telegram_id}
              onChange={e => set('telegram_id', e.target.value)} placeholder="사용자가 /connect 로 연결 가능" />
            <p className="text-xs text-gray-400 mt-1">직접 입력하거나 사용자가 /connect {'{아이디}'} 로 연결</p>
          </div>

          {!editId && (
            <p className="text-xs text-amber-600 bg-amber-50 rounded p-2">
              ⚠️ 등록 시 <strong>첫 로그인에 비밀번호 변경이 강제</strong>됩니다.
            </p>
          )}

          {error && <p className="text-red-500 text-sm">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button type="button" className="btn-secondary flex-1" onClick={() => setModal(false)}>취소</button>
            <button type="submit"  className="btn-primary flex-1"  disabled={saving}>
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        </form>
      </Modal>

      {/* 비밀번호 초기화 모달 */}
      <Modal open={resetModal} onClose={() => setResetModal(false)} title="🔑 비밀번호 초기화">
        <form onSubmit={handleReset} className="space-y-3">
          <p className="text-sm text-gray-600">
            임시 비밀번호를 설정합니다.<br />
            사용자는 다음 로그인 시 비밀번호 변경이 강제됩니다.
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">임시 비밀번호</label>
            <input className="input-base w-full" type="password" value={resetPw}
              onChange={e => setResetPw(e.target.value)} placeholder="8자 이상, 대소문자+숫자+특수문자" />
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button type="button" className="btn-secondary flex-1" onClick={() => setResetModal(false)}>취소</button>
            <button type="submit"  className="btn-primary flex-1"  disabled={saving}>
              {saving ? '처리 중...' : '초기화'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
