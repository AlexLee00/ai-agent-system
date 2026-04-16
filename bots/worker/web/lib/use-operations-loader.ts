// @ts-nocheck
'use client';

import { useCallback, useState } from 'react';
import { useAuthReadyRequest } from '@/lib/use-auth-ready-request';

export function useOperationsLoader(initialLoading = true) {
  const { runWhenReady } = useAuthReadyRequest();
  const [loading, setLoading] = useState(initialLoading);
  const [loadError, setLoadError] = useState('');

  const runLoad = useCallback(async (task, options = {}) => {
    const {
      errorMessage = '데이터를 불러오지 못했습니다.',
      onMissingAuth = null,
    } = options;

    return runWhenReady(async () => {
      setLoading(true);
      setLoadError('');
      try {
        return await task();
      } catch (error) {
        setLoadError(error?.message || errorMessage);
        return null;
      } finally {
        setLoading(false);
      }
    }, {
      onMissingAuth: () => {
        setLoading(false);
        if (typeof onMissingAuth === 'function') onMissingAuth();
      },
    });
  }, [runWhenReady]);

  return {
    loading,
    setLoading,
    loadError,
    setLoadError,
    runLoad,
  };
}
