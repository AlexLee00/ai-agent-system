// @ts-nocheck
'use client';

import { useEffect } from 'react';

export default function ServiceWorkerReset() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    const clearServiceWorkers = async () => {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
      } catch {
        // 무시
      }

      if (!('caches' in window)) return;

      try {
        const cacheKeys = await window.caches.keys();
        await Promise.all(cacheKeys.map((key) => window.caches.delete(key)));
      } catch {
        // 무시
      }
    };

    clearServiceWorkers();
  }, []);

  return null;
}
