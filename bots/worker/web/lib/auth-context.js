'use client';
import { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext(null);

const API_BASE = '/api';

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('worker_token') : null;
    if (!token) { setLoading(false); return; }

    fetch(`${API_BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.user) setUser(data.user); else localStorage.removeItem('worker_token'); })
      .catch(() => localStorage.removeItem('worker_token'))
      .finally(() => setLoading(false));
  }, []);

  const login = async (username, password) => {
    const res  = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '로그인 실패');
    localStorage.setItem('worker_token', data.token);
    setUser({ ...data.user, must_change_pw: !!data.must_change_pw });
    return data;
  };

  const refreshUser = async () => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('worker_token') : null;
    if (!token) return;
    const res  = await fetch(`${API_BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    const data = res.ok ? await res.json() : null;
    if (data?.user) setUser(data.user);
  };

  const logout = () => {
    localStorage.removeItem('worker_token');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() { return useContext(AuthContext); }

export function getToken() {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('worker_token');
}
