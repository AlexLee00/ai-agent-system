'use client';
import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import Card from '@/components/Card';
import { SalesBarChart } from '@/components/Chart';

const WEEKDAY = ['일','월','화','수','목','금','토'];

export default function DashboardPage() {
  const [summary, setSummary] = useState(null);
  const [salesData, setSalesData] = useState([]);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/dashboard/summary').catch(() => null),
      api.get('/sales/summary').catch(() => null),
    ]).then(([sum, sales]) => {
      if (sum) setSummary(sum);
      if (sales?.weekly) {
        setSalesData(sales.weekly.map(r => {
          const d = new Date(r.date);
          return { label: `${d.getMonth()+1}/${d.getDate()}(${WEEKDAY[d.getDay()]})`, total: Number(r.total) };
        }));
      }
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-center py-20 text-gray-400">로딩 중...</div>;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-gray-900">대시보드</h1>

      {/* 요약 카드 (2x2 그리드 → 1열) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card
          title="오늘 매출"
          value={`₩${(summary?.today_sales ?? 0).toLocaleString()}`}
          icon="💰"
          color="blue"
        />
        <Card
          title="출근 인원"
          value={`${summary?.checked_in ?? 0}명`}
          icon="👥"
          color="green"
        />
        <Card
          title="미처리 문서"
          value={`${summary?.pending_docs ?? 0}건`}
          icon="📋"
          color="yellow"
        />
        <Card
          title="대기 승인"
          value={`${summary?.pending_approvals ?? 0}건`}
          icon="✅"
          color="red"
        />
      </div>

      {/* 매출 차트 */}
      <div className="card">
        <h2 className="font-semibold text-gray-800 mb-4">📊 주간 매출 (최근 7일)</h2>
        {salesData.length > 0
          ? <SalesBarChart data={salesData} />
          : <p className="text-center text-gray-400 py-10">매출 데이터 없음</p>
        }
      </div>
    </div>
  );
}
