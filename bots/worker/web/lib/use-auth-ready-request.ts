// @ts-nocheck
'use client';

import { useCallback } from 'react';
import { getToken, useAuth } from '@/lib/auth-context';

export function useAuthReadyRequest() {
  const { user, loading: authLoading } = useAuth();

  const runWhenReady = useCallback(async (task, options = {}) => {
    if (authLoading) return { skipped: true, reason: 'auth_loading' };
    if (!getToken() || !user) {
      if (typeof options.onMissingAuth === 'function') options.onMissingAuth();
      return { skipped: true, reason: 'missing_auth' };
    }
    return task(user);
  }, [authLoading, user]);

  return {
    user,
    authLoading,
    isAuthReady: Boolean(!authLoading && user && getToken()),
    runWhenReady,
  };
}
