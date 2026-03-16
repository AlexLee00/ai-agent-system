'use client';
import { useState } from 'react';

/**
 * 반응형 데이터 테이블
 * PC: 일반 테이블 / 모바일: 카드 리스트
 *
 * Props:
 *   columns:   [{ key, label, render? }]
 *   data:      []
 *   actions?:  (row) => ReactNode
 *   emptyText?: string
 *   emptyNode?: ReactNode  — 커스텀 빈 상태 (CTA 포함 가능)
 *   pageSize?:  number     — 페이지당 행 수 (기본값 없음 = 전체)
 */
export default function DataTable({ columns, data, actions, emptyText = '데이터 없음', emptyNode, pageSize }) {
  const [page, setPage] = useState(1);

  if (!data?.length) {
    if (emptyNode) return emptyNode;
    return (
      <div className="text-center py-12 text-gray-400">
        <p className="text-4xl mb-2">📭</p>
        <p>{emptyText}</p>
      </div>
    );
  }

  const totalPages = pageSize ? Math.ceil(data.length / pageSize) : 1;
  const paged = pageSize ? data.slice((page - 1) * pageSize, page * pageSize) : data;

  return (
    <>
      {/* PC 테이블 */}
      <div className="hidden md:block overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b">
              {columns.map(col => (
                <th key={col.key} className="text-left py-3 px-4 font-medium text-gray-500">
                  {col.label}
                </th>
              ))}
              {actions && <th className="text-right py-3 px-4 font-medium text-gray-500">작업</th>}
            </tr>
          </thead>
          <tbody>
            {paged.map((row, i) => (
              <tr key={i} className="border-b hover:bg-gray-50 transition-colors">
                {columns.map(col => (
                  <td key={col.key} className="py-3 px-4 align-top text-gray-700 break-keep">
                    {col.render ? col.render(row[col.key], row) : (row[col.key] ?? '-')}
                  </td>
                ))}
                {actions && (
                  <td className="py-3 px-4 text-right">
                    {actions(row)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 모바일 카드 */}
      <div className="md:hidden space-y-3">
        {paged.map((row, i) => (
          <div key={i} className="card overflow-hidden">
            {columns.map(col => (
              <div key={col.key} className="flex flex-col gap-1 border-b py-2 last:border-0 sm:flex-row sm:items-start sm:justify-between">
                <span className="text-xs font-medium text-gray-500">{col.label}</span>
                <span className="text-left text-sm text-gray-800 break-keep sm:max-w-[60%] sm:text-right">
                  {col.render ? col.render(row[col.key], row) : (row[col.key] ?? '-')}
                </span>
              </div>
            ))}
            {actions && (
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                {actions(row)}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 페이지네이션 */}
      {pageSize && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mt-4 pt-4">
          <p className="text-sm text-gray-500 text-center sm:text-left">
            {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, data.length)} / 총 {data.length}건
          </p>
          <div className="flex items-center justify-center gap-1">
            <button
              onClick={() => setPage(1)}
              disabled={page === 1}
              className="w-8 h-8 rounded flex items-center justify-center text-sm text-gray-500 hover:bg-gray-100 disabled:opacity-30"
            >«</button>
            <button
              onClick={() => setPage(p => p - 1)}
              disabled={page === 1}
              className="w-8 h-8 rounded flex items-center justify-center text-sm text-gray-500 hover:bg-gray-100 disabled:opacity-30"
            >‹</button>
            {Array.from({ length: Math.min(3, totalPages) }, (_, i) => {
              const start = Math.max(1, Math.min(page - 1, totalPages - 2));
              const p = start + i;
              return (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={`w-8 h-8 rounded flex items-center justify-center text-sm font-medium
                    ${p === page ? 'bg-primary text-white' : 'text-gray-600 hover:bg-gray-100'}`}
                >{p}</button>
              );
            })}
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={page === totalPages}
              className="w-8 h-8 rounded flex items-center justify-center text-sm text-gray-500 hover:bg-gray-100 disabled:opacity-30"
            >›</button>
            <button
              onClick={() => setPage(totalPages)}
              disabled={page === totalPages}
              className="w-8 h-8 rounded flex items-center justify-center text-sm text-gray-500 hover:bg-gray-100 disabled:opacity-30"
            >»</button>
          </div>
        </div>
      )}
    </>
  );
}
