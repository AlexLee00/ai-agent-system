'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { UserCog } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import DataTable from '@/components/DataTable';
import Modal from '@/components/Modal';

const ROLES    = ['master', 'admin', 'member'];
const CHANNELS = [{ value: 'web', label: '웹 (아이디/비밀번호)' }, { value: 'telegram', label: '텔레그램' }];

const EMPTY_FORM = {
  username: '', password: '', name: '', role: 'member',
  company_id: '', email: '', channel: 'web', telegram_id: '', must_change_pw: true,
};

export default function AdminUsersPage() {
  const { user } = useAuth();
  const router   = useRouter();

  const [users,     setUsers]     = useState([]);
  const [companies, setCompanies] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [modal,     setModal]     = useState(false);
  const [resetModal,setResetModal]= useState(false);
  const [form,      setForm]      = useState(EMPTY_FORM);
  const [editId,    setEditId]    = useState(null);
  const [resetId,   setResetId]   = useState(null);
  const [resetPw,   setResetPw]   = useState('');
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');

  // 마스터 전용 페이지
  useEffect(() => {
    if (user && user.role !== 'master') router.push('/dashboard');
  }, [user, router]);

  const loadAll = () => {
    setLoading(true);
    Promise.all([
      api.get('/users').catch(() => ({ users: [] })),
      api.get('/companies').catch(() => ({ companies: [] })),
    ]).then(([u, c]) => {
      setUsers(u.users || []);
      setCompanies(c.companies || []);
    }).finally(() => setLoading(false));
  };

  useEffect(() => { loadAll(); }, []);

  const companyName = (id) => companies.find(c => c.id === id)?.name || id || '-';

  const openNew = () => { setForm(EMPTY_FORM); setEditId(null); setError(''); setModal(true); };
  const openEdit = (u) => {
    setForm({
      username: u.username || '', password: '',
      name: u.name || '', role: u.role || 'member',
      company_id: u.company_id || '', email: u.email || '',
      channel: u.channel || 'web', telegram_id: u.telegram_id || '',
      must_change_pw: u.must_change_pw ?? false,
    });
    setEditId(u.id); setError(''); setModal(true);
  };

  const openReset = (u) => { setResetId(u.id); setResetPw(''); setError(''); setResetModal(true); };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { setError('이름은 필수입니다.'); return; }
    if (!editId && !form.username.trim()) { setError('아이디는 필수입니다.'); return; }
    if (!editId && !form.password) { setError('비밀번호는 필수입니다.'); return; }
    if (!editId && !form.company_id) { setError('업체를 선택해주세요.'); return; }
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
          channel: form.channel, telegram_id: form.telegram_id || null,
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
      alert('비밀번호가 초기화되었습니다. 다음 로그인 시 변경이 강제됩니다.');
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id) => {
    if (id === user.id) { alert('자기 자신은 삭제할 수 없습니다.'); return; }
    if (!confirm('사용자를 삭제하시겠습니까?')) return;
    await api.delete(`/users/${id}`).catch(() => {});
    loadAll();
  };

  const columns = [
    { key: 'username',   label: '아이디' },
    { key: 'name',       label: '이름' },
    { key: 'role',       label: '역할',   render: v => ({ master:'마스터', admin:'관리자', member:'멤버' }[v] || v) },
    { key: 'company_id', label: '업체',   render: v => companyName(v) },
    { key: 'channel',    label: '채널',   render: v => v === 'telegram' ? '📱 텔레그램' : '🌐 웹' },
    { key: 'must_change_pw', label: '초기화', render: v => v ? '🔑 변경필요' : '-' },
    { key: 'last_login_at',  label: '최근로그인', render: v => v ? new Date(v).toLocaleString('ko-KR') : '-' },
  ];

  const emptyNode = (
    <div className="text-center py-12">
      <p className="text-4xl mb-3">👤</p>
      <p className="text-gray-500 mb-4">등록된 사용자가 없습니다</p>
      <button onClick={openNew} className="btn-primary text-sm">+ 사용자 등록하기</button>
    </div>
  );

  if (user?.role !== 'master') return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UserCog className="w-6 h-6 text-indigo-600" />
          <h1 className="text-xl font-bold text-gray-900">사용자 관리</h1>
          <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">MASTER</span>
        </div>
        <button className="btn-primary text-sm" onClick={openNew}>+ 사용자 등록</button>
      </div>

      <div className="card overflow-x-auto">
        {loading
          ? <p className="text-center py-10 text-gray-400">로딩 중...</p>
          : <DataTable
              columns={columns}
              data={users}
              emptyNode={emptyNode}
              actions={row => (
                <div className="flex gap-1">
                  <button className="btn-secondary text-xs px-2 py-1" onClick={() => openEdit(row)}>수정</button>
                  <button className="btn-secondary text-xs px-2 py-1" onClick={() => openReset(row)}>PW초기화</button>
                  <button className="btn-danger   text-xs px-2 py-1" onClick={() => handleDelete(row.id)}>삭제</button>
                </div>
              )}
            />
        }
      </div>

      {/* 사용자 등록/수정 모달 */}
      <Modal open={modal} onClose={() => setModal(false)} title={editId ? '사용자 수정' : '사용자 등록'}>
        <form onSubmit={handleSave} className="space-y-4">
          {!editId && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">아이디 *</label>
                  <input className="input-base font-mono" value={form.username}
                    onChange={e => setForm(p => ({ ...p, username: e.target.value }))} placeholder="영문/숫자/_" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">임시 비밀번호 *</label>
                  <input className="input-base" type="password" value={form.password}
                    onChange={e => setForm(p => ({ ...p, password: e.target.value }))} />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">업체 *</label>
                <select className="input-base" value={form.company_id}
                  onChange={e => setForm(p => ({ ...p, company_id: e.target.value }))}>
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
                onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
            </div>
            {!editId && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">역할</label>
                <select className="input-base" value={form.role}
                  onChange={e => setForm(p => ({ ...p, role: e.target.value }))}>
                  {ROLES.map(r => <option key={r} value={r}>{{ master:'마스터', admin:'관리자', member:'멤버' }[r]}</option>)}
                </select>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">이메일</label>
            <input className="input-base" type="email" value={form.email}
              onChange={e => setForm(p => ({ ...p, email: e.target.value }))} />
          </div>

          {!editId && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">접속 채널</label>
              <select className="input-base" value={form.channel}
                onChange={e => setForm(p => ({ ...p, channel: e.target.value }))}>
                {CHANNELS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
          )}

          {form.channel === 'telegram' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">텔레그램 ID (chat_id)</label>
              <input className="input-base font-mono" type="number" value={form.telegram_id}
                onChange={e => setForm(p => ({ ...p, telegram_id: e.target.value }))}
                placeholder="예: ***REMOVED***" />
            </div>
          )}

          {error && <p className="text-red-500 text-sm">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button type="button" className="btn-secondary flex-1" onClick={() => setModal(false)}>취소</button>
            <button type="submit"  className="btn-primary flex-1"  disabled={saving}>{saving ? '저장 중...' : '저장'}</button>
          </div>
        </form>
      </Modal>

      {/* 비밀번호 초기화 모달 */}
      <Modal open={resetModal} onClose={() => setResetModal(false)} title="비밀번호 초기화">
        <form onSubmit={handleReset} className="space-y-4">
          <p className="text-sm text-gray-600">
            임시 비밀번호를 설정합니다. 사용자는 다음 로그인 시 비밀번호 변경이 강제됩니다.
          </p>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">임시 비밀번호</label>
            <input className="input-base" type="password" value={resetPw}
              onChange={e => setResetPw(e.target.value)} placeholder="8자 이상" />
          </div>
          {error && <p className="text-red-500 text-sm">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button type="button" className="btn-secondary flex-1" onClick={() => setResetModal(false)}>취소</button>
            <button type="submit"  className="btn-primary flex-1"  disabled={saving}>{saving ? '처리 중...' : '초기화'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
