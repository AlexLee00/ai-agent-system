'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Link2, RefreshCcw, Save } from 'lucide-react';
import AdminQuickNav from '@/components/AdminQuickNav';
import AdminPageHero from '@/components/AdminPageHero';
import { api } from '@/lib/api';

export default function BlogPublishedUrlPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [payload, setPayload] = useState(null);
  const [selectedPostId, setSelectedPostId] = useState('');
  const [url, setUrl] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.get('/admin/monitoring/blog-published-urls');
      setPayload(data);
      setSelectedPostId((current) => {
        const pending = (data.rows || []).filter((row) => row.needs_url);
        if (pending.some((row) => String(row.id) === String(current))) return current;
        return String(pending[0]?.id || '');
      });
    } catch (err) {
      setError(err.message || '블로그 발행 URL 목록을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const rows = payload?.rows || [];
  const summary = payload?.summary || { total: 0, missingUrl: 0, scheduled: 0, published: 0 };
  const pendingRows = useMemo(
    () => rows.filter((row) => row.needs_url),
    [rows],
  );
  const scheduledRows = useMemo(
    () => rows.filter((row) => row.scheduled),
    [rows],
  );
  const selectedPost = useMemo(
    () => pendingRows.find((row) => String(row.id) === String(selectedPostId)) || null,
    [pendingRows, selectedPostId],
  );

  async function handleSubmit(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const data = await api.post('/admin/monitoring/blog-published-urls', {
        post_id: Number(selectedPostId),
        url: url.trim(),
      });
      setPayload({ rows: data.rows || [], summary: data.summary || summary });
      setNotice(data.message || '블로그 발행 URL을 저장했습니다.');
      setUrl('');
      setSelectedPostId(String((data.rows || []).find((row) => row.needs_url)?.id || ''));
    } catch (err) {
      setError(err.message || '블로그 발행 URL을 저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <AdminQuickNav />

      <AdminPageHero
        title="블로그 발행 URL 입력"
        badge="MONITORING"
        tone="slate"
        description="수동 발행한 네이버 블로그 URL을 운영 화면에서 바로 기록합니다. 기록된 URL은 내부 링킹과 발행 상태 판단의 기준이 됩니다."
        stats={[
          { label: '최근 글', value: summary.total || 0, caption: '최근 20건 기준' },
          { label: '입력 필요', value: summary.missingUrl || 0, caption: '발행 후 URL 후처리 대상' },
          { label: '발행예정', value: summary.scheduled || 0, caption: 'ready + URL 미입력' },
          { label: '발행 완료', value: summary.published || 0, caption: 'naver_url 기록 포함' },
        ]}
      />

      {error && <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
      {notice && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <form onSubmit={handleSubmit} className="card space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">발행 URL 기록</p>
              <p className="mt-1 text-sm text-slate-500">이미 발행된 글 중 URL이 비어 있는 경우만 입력 대상으로 보입니다. `ready` 상태 글은 발행예정 섹션에서 따로 확인합니다.</p>
            </div>
            <button type="button" className="btn-secondary text-sm" onClick={load} disabled={loading}>
              <RefreshCcw className="mr-2 h-4 w-4" />
              새로고침
            </button>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-500">대상 글</label>
            <select
              className="input-base mt-2"
              value={selectedPostId}
              onChange={(event) => setSelectedPostId(event.target.value)}
              disabled={loading || saving}
            >
              <option value="">글을 선택하세요</option>
              {pendingRows.map((row) => (
                <option key={row.id} value={row.id}>
                  #{row.id} · {row.title}
                </option>
              ))}
            </select>
            {!pendingRows.length && (
              <p className="mt-2 text-xs text-slate-500">현재 실제 URL 입력이 필요한 발행 완료 글이 없습니다.</p>
            )}
            {selectedPost && (
              <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                <p>현재 상태: <span className="font-semibold text-slate-900">{selectedPost.status}</span></p>
                <p className="mt-1 break-all">현재 URL: {selectedPost.naver_url || '미입력'}</p>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-500">네이버 블로그 URL</label>
            <input
              className="input-base mt-2"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://blog.naver.com/cafe_library/224220774105"
              disabled={loading || saving}
            />
            <p className="mt-2 text-[11px] text-slate-500">`blog.naver.com`, `m.blog.naver.com`, `PostView.naver` 형식을 모두 받을 수 있고 저장 시 canonical URL로 정규화합니다.</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className="btn-primary text-sm"
              disabled={loading || saving || !selectedPostId || !url.trim()}
            >
              <Save className="mr-2 h-4 w-4" />
              {saving ? '저장 중...' : '발행 URL 저장'}
            </button>
            <Link href="/admin/monitoring" className="text-sm font-medium text-slate-600 hover:text-slate-900">
              LLM API 현황으로 돌아가기
            </Link>
          </div>
        </form>

        <div className="card space-y-4">
          <div className="flex items-center gap-2">
            <Link2 className="h-5 w-5 text-indigo-600" />
            <div>
              <p className="text-sm font-semibold text-slate-900">최근 블로그 글</p>
              <p className="text-xs text-slate-500">실제 URL 후처리 대상과 내일 발행 예정 글을 분리해서 보여줍니다.</p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">URL 입력 필요</p>
              <div className="mt-3 space-y-3">
            {pendingRows.map((row) => (
              <div key={row.id} className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900">#{row.id} {row.title}</p>
                    <p className="mt-1 text-xs text-slate-500">상태: {row.status} · 생성: {row.created_at ? new Date(row.created_at).toLocaleString('ko-KR') : '-'}</p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${row.naver_url ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                    {row.naver_url ? 'URL 있음' : 'URL 필요'}
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate text-xs text-slate-500">{row.naver_url || '아직 저장된 네이버 URL이 없습니다.'}</p>
                  {row.naver_url ? (
                    <a
                      href={row.naver_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-slate-700 hover:text-slate-900"
                    >
                      열기
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : (
                    <button
                      type="button"
                      className="text-xs font-medium text-slate-700 hover:text-slate-900"
                      onClick={() => setSelectedPostId(String(row.id))}
                    >
                      이 글 선택
                    </button>
                  )}
                </div>
              </div>
            ))}
              {!pendingRows.length && !loading && (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                현재 실제 URL 입력이 필요한 발행 완료 글이 없습니다.
              </div>
            )}
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">발행예정</p>
              <div className="mt-3 space-y-3">
                {scheduledRows.map((row) => (
                  <div key={row.id} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900">#{row.id} {row.title}</p>
                        <p className="mt-1 text-xs text-slate-500">상태: {row.status} · 생성: {row.created_at ? new Date(row.created_at).toLocaleString('ko-KR') : '-'}</p>
                      </div>
                      <span className="shrink-0 rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-700">
                        발행예정
                      </span>
                    </div>
                    <p className="mt-3 text-xs text-slate-500">당일 예약 등록 후 다음날 오전 7시에 실제 발행되는 글입니다. 실제 발행 후 URL 입력 대상으로 이동합니다.</p>
                  </div>
                ))}
                {!scheduledRows.length && !loading && (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
                    현재 발행예정인 최근 글이 없습니다.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
