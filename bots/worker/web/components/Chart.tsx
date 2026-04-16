// @ts-nocheck
'use client';
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';

function formatAmount(v) {
  if (v >= 1000000) return `${(v/1000000).toFixed(1)}M`;
  if (v >= 1000)    return `${(v/1000).toFixed(0)}K`;
  return String(v);
}

export function SalesBarChart({ data }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} />
        <YAxis tickFormatter={formatAmount} tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v) => [`₩${Number(v).toLocaleString()}`, '매출']} />
        <Bar dataKey="total" fill="#3B82F6" radius={[4,4,0,0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function SalesLineChart({ data }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey="label" tick={{ fontSize: 11 }} />
        <YAxis tickFormatter={formatAmount} tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v) => [`₩${Number(v).toLocaleString()}`, '매출']} />
        <Line type="monotone" dataKey="total" stroke="#3B82F6" strokeWidth={2} dot={{ r: 4 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}
