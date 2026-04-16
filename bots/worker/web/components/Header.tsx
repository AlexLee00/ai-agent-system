// @ts-nocheck
'use client';
import { useState, useEffect } from 'react';
import { Menu, X } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import Sidebar from './Sidebar';

export default function Header({ title }) {
  const { user } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // 드로어 열릴 때 body 스크롤 차단
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [drawerOpen]);

  return (
    <>
      <header className="safe-area-pt sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-slate-200 bg-white/90 px-3 backdrop-blur sm:h-16 sm:gap-3 sm:px-4">
        {/* 햄버거 (모바일/태블릿) */}
        <button
          onClick={() => setDrawerOpen(true)}
          className="lg:hidden flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg p-2 hover:bg-gray-100"
        >
          <Menu className="w-5 h-5 text-gray-600" />
        </button>

        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-slate-800 sm:text-xl">{title || '워커 업무 운영'}</h2>

        {user && (
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-sm font-bold text-white sm:h-9 sm:w-9">
              {(user.name || user.username).charAt(0)}
            </div>
          </div>
        )}
      </header>

      {/* 드로어 */}
      {drawerOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="flex h-full w-[min(18rem,86vw)] flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between p-4 border-b flex-shrink-0">
              <span className="font-bold">메뉴</span>
              <button
                onClick={() => setDrawerOpen(false)}
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg p-2 hover:bg-gray-100"
              >
                <X className="w-5 h-5 text-gray-600" />
              </button>
            </div>
            <div className="flex-1 min-h-0" onClick={() => setDrawerOpen(false)}>
              <Sidebar />
            </div>
          </div>
          <div
            className="flex-1 bg-black/40"
            onClick={() => setDrawerOpen(false)}
          />
        </div>
      )}
    </>
  );
}
