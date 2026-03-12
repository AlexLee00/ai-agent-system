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
      <header className="sticky top-0 z-40 bg-white border-b px-4 h-14 flex items-center gap-3">
        {/* 햄버거 (모바일/태블릿) */}
        <button
          onClick={() => setDrawerOpen(true)}
          className="lg:hidden p-2 rounded-lg hover:bg-gray-100 min-w-[44px] min-h-[44px] flex items-center justify-center"
        >
          <Menu className="w-5 h-5 text-gray-600" />
        </button>

        <h2 className="font-semibold text-gray-800 flex-1">{title || '워커 업무관리'}</h2>

        {user && (
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-primary rounded-full flex items-center justify-center text-white text-sm font-bold">
              {(user.name || user.username).charAt(0)}
            </div>
          </div>
        )}
      </header>

      {/* 드로어 */}
      {drawerOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="w-64 bg-white shadow-xl flex flex-col h-full">
            <div className="flex items-center justify-between p-4 border-b flex-shrink-0">
              <span className="font-bold">메뉴</span>
              <button
                onClick={() => setDrawerOpen(false)}
                className="p-2 rounded-lg hover:bg-gray-100 min-w-[44px] min-h-[44px] flex items-center justify-center"
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
