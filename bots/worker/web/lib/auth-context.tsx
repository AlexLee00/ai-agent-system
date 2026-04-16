// @ts-nocheck
'use client';
import { createContext, useContext, useState, useEffect } from 'react';
import { getWorkerWebRuntimeConfig } from '@/lib/runtime-config';

const AuthContext = createContext(null);
const webRuntimeConfig = getWorkerWebRuntimeConfig();
const REQUEST_TIMEOUT_MS = Number(webRuntimeConfig.authRequestTimeoutMs || 5000);
const AUTH_RELEASE_BUFFER_MS = Number(webRuntimeConfig.authReleaseBufferMs || 1500);

function normalizeEnabledMenus(enabledMenus) {
  if (!Array.isArray(enabledMenus)) return enabledMenus ?? null;
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
  return [...new Set(mapped)];
}

function normalizeUser(user) {
  if (!user) return user;
  return {
    ...user,
    enabled_menus: normalizeEnabledMenus(user.enabled_menus),
  };
}

function getApiBases() {
  if (typeof window === 'undefined') return ['/api'];
  return [
    '/api',
    `${window.location.protocol}//${window.location.hostname}:4000/api`,
  ];
}

async function fetchJsonWithFallback(path, options = {}) {
  let lastError = null;

  for (const apiBase of getApiBases()) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${apiBase}${path}`, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      return { response, data };
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
    }
  }

  throw lastError || new Error('API 요청 실패');
}

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const releaseTimer = setTimeout(() => {
      if (!alive) return;
      try {
        localStorage.removeItem('worker_token');
      } catch {}
      setLoading(false);
    }, REQUEST_TIMEOUT_MS + AUTH_RELEASE_BUFFER_MS);

    let token = null;
    try {
      token = typeof window !== 'undefined' ? localStorage.getItem('worker_token') : null;
    } catch {
      token = null;
    }
    if (!token) {
      clearTimeout(releaseTimer);
      setLoading(false);
      return () => {
        alive = false;
        clearTimeout(releaseTimer);
      };
    }

    fetchJsonWithFallback('/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(({ response, data }) => {
        if (!alive) return;
        if (response.ok && data?.user) setUser(normalizeUser(data.user));
        else {
          try {
            localStorage.removeItem('worker_token');
          } catch {}
        }
      })
      .catch(() => {
        try {
          localStorage.removeItem('worker_token');
        } catch {}
      })
      .finally(() => {
        if (!alive) return;
        clearTimeout(releaseTimer);
        setLoading(false);
      });

    return () => {
      alive = false;
      clearTimeout(releaseTimer);
    };
  }, []);

  const login = async (username, password) => {
    const { response, data } = await fetchJsonWithFallback('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!response.ok) throw new Error(data?.error || '로그인 실패');
    localStorage.setItem('worker_token', data.token);
    setUser(normalizeUser({ ...data.user, must_change_pw: !!data.must_change_pw }));
    return data;
  };

  const refreshUser = async () => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('worker_token') : null;
    if (!token) return;
    const { response, data } = await fetchJsonWithFallback('/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok && data?.user) setUser(normalizeUser(data.user));
  };

  const logout = () => {
    try {
      localStorage.removeItem('worker_token');
    } catch {}
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
