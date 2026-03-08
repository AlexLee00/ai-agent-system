'use client';
import { useState } from 'react';

/**
 * 반응형 데이터 테이블
 * PC: 일반 테이블 / 모바일: 카드 리스트
 *
 * Props:
 *   columns: [{ key, label, render? }]
 *   data: []
 *   actions?: (row) => ReactNode
 *   emptyText?: string
 */
export default function DataTable({ columns, data, actions, emptyText = '데이터 없음' }) {
  if (!data?.length) {
    return (
      <div className="text-center py-12 text-gray-400">
        <p className="text-4xl mb-2">📭</p>
        <p>{emptyText}</p>
      </div>
    );
  }

  return (
    <>
      {/* PC 테이블 */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
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
            {data.map((row, i) => (
              <tr key={i} className="border-b hover:bg-gray-50 transition-colors">
                {columns.map(col => (
                  <td key={col.key} className="py-3 px-4 text-gray-700">
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
        {data.map((row, i) => (
          <div key={i} className="card">
            {columns.map(col => (
              <div key={col.key} className="flex justify-between py-1.5 border-b last:border-0">
                <span className="text-xs text-gray-500 font-medium">{col.label}</span>
                <span className="text-sm text-gray-800 text-right">
                  {col.render ? col.render(row[col.key], row) : (row[col.key] ?? '-')}
                </span>
              </div>
            ))}
            {actions && (
              <div className="mt-3 flex justify-end gap-2">
                {actions(row)}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
