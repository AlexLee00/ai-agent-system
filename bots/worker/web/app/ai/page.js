'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import DataTable from '@/components/DataTable';

// XSS 방지 — AI 답변·예측 텍스트에 HTML 특수문자 이스케이프
function sanitizeText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function TrendBadge({ trend }) {
  const map = {
    '상승': 'bg-green-100 text-green-700',
    '하락': 'bg-red-100 text-red-700',
    '횡보': 'bg-gray-100 text-gray-600',
  };
  return <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${map[trend] || 'bg-gray-100 text-gray-600'}`}>{trend}</span>;
}

function ConfidenceBadge({ confidence }) {
  const map = {
    high:   'bg-green-100 text-green-700',
    medium: 'bg-yellow-100 text-yellow-700',
    low:    'bg-red-100 text-red-700',
  };
  const label = { high: '높음', medium: '보통', low: '낮음' };
  return <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${map[confidence] || 'bg-gray-100 text-gray-600'}`}>{label[confidence] || confidence}</span>;
}

export default function AIPage() {
  // ── AI 질문 상태 ──
  const [question,  setQuestion]  = useState('');
  const [asking,    setAsking]    = useState(false);
  const [askResult, setAskResult] = useState(null);
  const [askError,  setAskError]  = useState('');

  // ── 매출 예측 상태 ──
  const [forecasting, setForecasting] = useState(false);
  const [forecast,    setForecast]    = useState(null);
  const [fcError,     setFcError]     = useState('');

  const handleAsk = async (e) => {
    e.preventDefault();
    if (!question.trim()) return;
    setAsking(true); setAskError(''); setAskResult(null);
    try {
      const res = await api.post('/ai/ask', { question });
      setAskResult(res);
    } catch (e) { setAskError(e.message); }
    finally { setAsking(false); }
  };

  const handleForecast = async () => {
    setForecasting(true); setFcError(''); setForecast(null);
    try {
      const res = await api.post('/ai/revenue-forecast', {});
      setForecast(res);
    } catch (e) { setFcError(e.message); }
    finally { setForecasting(false); }
  };

  // 데이터 테이블 컬럼 동적 생성
  const dataColumns = askResult?.data?.length > 0
    ? Object.keys(askResult.data[0]).map(k => ({ key: k, label: k }))
    : [];

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-xl font-bold text-gray-900">AI 분석</h1>

      {/* ── AI 질문 ── */}
      <div className="card space-y-4">
        <h2 className="font-semibold text-gray-800">자연어 질문</h2>
        <p className="text-sm text-gray-500">업무 데이터에 대해 자유롭게 질문하세요. AI가 데이터를 조회하고 분석합니다.</p>

        <form onSubmit={handleAsk} className="flex gap-2">
          <input
            className="input-base flex-1"
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder="예: 이번 달 출근율이 가장 높은 직원은 누구인가요?"
            disabled={asking}
          />
          <button className="btn-primary px-5" type="submit" disabled={asking || !question.trim()}>
            {asking ? '분석 중...' : '질문'}
          </button>
        </form>

        {/* 예시 질문 */}
        <div className="flex flex-wrap gap-2">
          {[
            '이번 달 매출 합계는?',
            '지각 횟수가 가장 많은 직원은?',
            '완료되지 않은 프로젝트 목록',
            '3월 급여 총액은 얼마인가요?',
          ].map(q => (
            <button
              key={q}
              onClick={() => setQuestion(q)}
              className="text-xs px-3 py-1.5 bg-gray-100 hover:bg-indigo-50 hover:text-indigo-700 text-gray-600 rounded-full transition-colors"
            >
              {q}
            </button>
          ))}
        </div>

        {askError && <p className="text-red-500 text-sm">{askError}</p>}

        {askResult && (
          <div className="space-y-3">
            {/* 답변 */}
            <div className="bg-indigo-50 rounded-lg p-4">
              <p className="text-sm font-medium text-indigo-900 whitespace-pre-wrap">{sanitizeText(askResult.answer)}</p>
            </div>

            {/* 메타 정보 */}
            <div className="flex gap-3 text-xs text-gray-400">
              <span>조회 {askResult.rowCount}건</span>
              {askResult.ragUsed && <span className="text-indigo-500">RAG 문서 참조</span>}
            </div>

            {/* 데이터 테이블 */}
            {askResult.data?.length > 0 && (
              <div>
                <p className="text-xs font-medium text-gray-500 mb-2">원본 데이터 (최대 50건)</p>
                <div className="overflow-x-auto">
                  <DataTable columns={dataColumns} data={askResult.data} emptyText="데이터 없음" />
                </div>
              </div>
            )}

            {/* SQL 보기 */}
            <details className="text-xs">
              <summary className="cursor-pointer text-gray-400 hover:text-gray-600">실행된 SQL 보기</summary>
              <pre className="mt-2 bg-gray-50 rounded p-3 overflow-x-auto text-gray-700 text-xs">{askResult.sql}</pre>
            </details>
          </div>
        )}
      </div>

      {/* ── 매출 예측 ── */}
      <div className="card space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-gray-800">매출 AI 예측</h2>
            <p className="text-sm text-gray-500 mt-0.5">최근 90일 매출 데이터 기반 30일 예측</p>
          </div>
          <button className="btn-primary text-sm" onClick={handleForecast} disabled={forecasting}>
            {forecasting ? '예측 중...' : '예측 실행'}
          </button>
        </div>

        {fcError && <p className="text-red-500 text-sm">{fcError}</p>}

        {forecast && (
          <>
            {forecast.message ? (
              <p className="text-sm text-amber-600 bg-amber-50 rounded-lg p-3">{forecast.message}</p>
            ) : forecast.forecast && (
              <div className="space-y-3">
                {/* 핵심 지표 */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="bg-gray-50 rounded-lg p-3 text-center">
                    <p className="text-xs text-gray-500 mb-1">트렌드</p>
                    <TrendBadge trend={forecast.forecast.trend} />
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3 text-center">
                    <p className="text-xs text-gray-500 mb-1">신뢰도</p>
                    <ConfidenceBadge confidence={forecast.forecast.confidence} />
                  </div>
                  <div className="bg-indigo-50 rounded-lg p-3 text-center col-span-2">
                    <p className="text-xs text-gray-500 mb-1">30일 예상 매출</p>
                    <p className="font-bold text-indigo-700">
                      ₩{Number(forecast.forecast.forecast_30d_total || 0).toLocaleString()}
                    </p>
                    <p className="text-xs text-gray-400">일평균 ₩{Number(forecast.forecast.forecast_30d_daily_avg || 0).toLocaleString()}</p>
                  </div>
                </div>

                {/* 분석 */}
                <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
                  <p className="text-gray-700">{sanitizeText(forecast.forecast.analysis)}</p>
                  {forecast.forecast.weekly_pattern && (
                    <p className="text-gray-500 text-xs">{sanitizeText(forecast.forecast.weekly_pattern)}</p>
                  )}
                  {forecast.forecast.warnings && (
                    <p className="text-amber-600 text-xs">{sanitizeText(forecast.forecast.warnings)}</p>
                  )}
                </div>

                <p className="text-xs text-gray-400">
                  분석 기간: {forecast.period?.from} ~ {forecast.period?.to} ({forecast.dataPoints}일)
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
