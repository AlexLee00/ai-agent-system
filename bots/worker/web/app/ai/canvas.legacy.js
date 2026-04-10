'use client';
import { useState } from 'react';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

const COLORS = ['#6366F1', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6'];

// ── 파싱 헬퍼 ─────────────────────────────────────────────────────────

function parseMarkdownTable(text) {
  const lines = text.split('\n');
  const startIdx = lines.findIndex(l => /^\|.+\|/.test(l.trim()));
  if (startIdx === -1) return null;

  const tableLines = [];
  for (let i = startIdx; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^\|/.test(l)) tableLines.push(l);
    else if (tableLines.length > 0) break;
  }
  if (tableLines.length < 3) return null;

  const sepIdx = tableLines.findIndex((l, i) => i > 0 && /^\|[\s\-:|]+\|$/.test(l));
  if (sepIdx === -1) return null;

  const headers = tableLines[0].split('|').map(h => h.trim()).filter(Boolean);
  if (headers.length < 2) return null;

  const data = tableLines.slice(sepIdx + 1)
    .filter(l => l.startsWith('|'))
    .map(row => {
      const cells = row.split('|').slice(1, -1).map(c => c.trim());
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cells[i] ?? ''; });
      return obj;
    })
    .filter(row => Object.values(row).some(v => v));

  return data.length ? { columns: headers, data } : null;
}

function parseDiff(text) {
  const files = [];
  let currentFile = null;
  let currentHunk = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ ') && !line.startsWith('++++')) {
      const filename = line.slice(4).replace(/^[ab]\//, '').trim();
      if (filename && filename !== '/dev/null') {
        currentFile = { filename, additions: 0, deletions: 0, hunks: [] };
        files.push(currentFile);
      }
    } else if (line.startsWith('@@ ') && currentFile) {
      currentHunk = { header: line, lines: [] };
      currentFile.hunks.push(currentHunk);
    } else if (currentHunk) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentHunk.lines.push({ type: 'addition', content: line.slice(1) });
        currentFile.additions++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentHunk.lines.push({ type: 'deletion', content: line.slice(1) });
        currentFile.deletions++;
      } else {
        currentHunk.lines.push({ type: 'context', content: line.startsWith(' ') ? line.slice(1) : line });
      }
    }
  }
  return files.length ? { type: 'code_diff', files } : null;
}

function extractStatCards(text) {
  const patterns = [
    { regex: /PnL[:\s]+([+-]?\d+\.?\d*\s*%?)/, label: 'PnL', icon: '📈' },
    { regex: /매출[:\s]+([\d,]+\s*원?)/, label: '매출', icon: '💰' },
    { regex: /거래\s*건수?[:\s]*(\d+\s*건?)/, label: '거래', icon: '📊' },
    { regex: /포지션[:\s]*(\d+\s*개?)/, label: '포지션', icon: '📋' },
    { regex: /수익[:\s]+([+-]?\d+\.?\d*\s*%?)/, label: '수익', icon: '💹' },
    { regex: /비용[:\s]+(\$?\d+\.?\d*)/, label: '비용', icon: '💸' },
    { regex: /토큰[:\s]+([\d,]+)/, label: '토큰', icon: '🔢' },
    { regex: /에러[:\s]*(\d+\s*건?)/, label: '에러', icon: '⚠️' },
    { regex: /성공[:\s]*(\d+\s*건?)/, label: '성공', icon: '✅' },
    { regex: /실패[:\s]*(\d+\s*건?)/, label: '실패', icon: '❌' },
  ];
  const cards = [];
  for (const p of patterns) {
    const m = text.match(p.regex);
    if (m) {
      const value = (m[1] || '').trim();
      const color = value.startsWith('+') ? 'green' : value.startsWith('-') ? 'red' : 'blue';
      cards.push({ label: p.label, value, color, icon: p.icon });
    }
  }
  return cards;
}

// ── 메인 파서 ─────────────────────────────────────────────────────────

export function parseClaudeOutput(text) {
  if (!text || text.length < 10 || text.length > 80000) return null;

  // 1. 명시적 JSON 블록
  const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      const KNOWN = ['table', 'chart_line', 'chart_bar', 'chart_pie', 'stat_cards',
        'json_view', 'code_diff', 'code_block', 'file_tree', 'status_card',
        'progress', 'timeline', 'form', 'select', 'confirm'];
      if (parsed?.type && KNOWN.includes(parsed.type)) return parsed;
      if (Array.isArray(parsed) && parsed.length && typeof parsed[0] === 'object') {
        const cols = Object.keys(parsed[0]);
        return { type: 'table', columns: cols, data: parsed.slice(0, 200) };
      }
      if (typeof parsed === 'object' && parsed !== null) {
        return { type: 'json_view', data: parsed };
      }
    } catch {}
  }

  // 2. diff
  if ((text.includes('+++ ') || text.includes('--- ')) && text.includes('@@ ')) {
    const diff = parseDiff(text);
    if (diff) return diff;
  }

  // 3. 마크다운 테이블
  const tableResult = parseMarkdownTable(text);
  if (tableResult) return { type: 'table', ...tableResult };

  // 4. 코드 블록 (100자 이상)
  const codeMatch = text.match(/```(\w+)\n([\s\S]*?)\n```/);
  if (codeMatch && codeMatch[2].length > 80) {
    return { type: 'code_block', language: codeMatch[1], code: codeMatch[2] };
  }

  // 5. stat_cards 자동 감지 (2개 이상 지표)
  const stats = extractStatCards(text);
  if (stats.length >= 2) return { type: 'stat_cards', cards: stats };

  return null;
}

// ── 캔버스 타입 레이블 ────────────────────────────────────────────────

export const CANVAS_LABELS = {
  table: '데이터 테이블', chart_line: '라인 차트', chart_bar: '바 차트', chart_pie: '파이 차트',
  stat_cards: '통계 카드', json_view: 'JSON', code_diff: '코드 변경', code_block: '코드',
  file_tree: '파일 목록', status_card: '봇 상태', progress: '진행 상황', timeline: '타임라인',
  form: '입력 폼', select: '선택지', confirm: '확인',
};

export const CANVAS_BADGES = {
  table: '📊', chart_line: '📈', chart_bar: '📊', chart_pie: '🥧',
  stat_cards: '🔢', json_view: '{ }', code_diff: '±', code_block: '</>',
  file_tree: '📁', status_card: '🟢', progress: '⏳', timeline: '📅',
  form: '📝', select: '☰', confirm: '❓',
};

// ── 1. DataTable ──────────────────────────────────────────────────────

export function CanvasDataTable({ columns, data, sortable = true, filterable = true }) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [filter,  setFilter]  = useState('');

  const cols = columns
    ? columns.map(c => typeof c === 'string' ? { key: c, label: c } : c)
    : data?.length ? Object.keys(data[0]).map(k => ({ key: k, label: k })) : [];

  let rows = data || [];
  if (filter) rows = rows.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(filter.toLowerCase())));
  if (sortKey) {
    rows = [...rows].sort((a, b) => {
      const r = String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? ''), undefined, { numeric: true });
      return sortDir === 'asc' ? r : -r;
    });
  }

  const handleSort = (key) => {
    if (!sortable) return;
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  return (
    <div>
      {filterable && (
        <input className="mb-2 w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          placeholder="검색..." value={filter} onChange={e => setFilter(e.target.value)} />
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-100">
              {cols.map(col => (
                <th key={col.key} onClick={() => handleSort(col.key)}
                  className={`text-left py-2 px-2 font-medium text-gray-500 whitespace-nowrap ${sortable ? 'cursor-pointer hover:text-gray-700 select-none' : ''}`}>
                  {col.label}{sortKey === col.key && <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 100).map((row, i) => (
              <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                {cols.map(col => (
                  <td key={col.key} className="py-1.5 px-2 text-gray-700 max-w-[180px] truncate">{row[col.key] ?? '-'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 100 && <p className="text-xs text-gray-400 mt-1 text-center">상위 100개 표시 (전체 {rows.length}개)</p>}
        {rows.length === 0 && <p className="text-xs text-gray-400 text-center py-4">데이터 없음</p>}
      </div>
    </div>
  );
}

// ── 2. LineChart ──────────────────────────────────────────────────────

export function CanvasLineChart({ data, xKey = 'label', yKey, color = '#6366F1' }) {
  if (!data?.length) return <p className="text-xs text-gray-400 py-4 text-center">데이터 없음</p>;
  const yk = yKey || Object.keys(data[0]).find(k => k !== xKey && !isNaN(Number(data[0][k])));
  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey={xKey} tick={{ fontSize: 10 }} />
        <YAxis tick={{ fontSize: 10 }} />
        <Tooltip />
        <Line type="monotone" dataKey={yk} stroke={color} strokeWidth={2} dot={{ r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ── 3. BarChart ───────────────────────────────────────────────────────

export function CanvasBarChart({ data, xKey = 'label', yKey, color = '#6366F1' }) {
  if (!data?.length) return <p className="text-xs text-gray-400 py-4 text-center">데이터 없음</p>;
  const yk = yKey || Object.keys(data[0]).find(k => k !== xKey && !isNaN(Number(data[0][k])));
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
        <XAxis dataKey={xKey} tick={{ fontSize: 10 }} />
        <YAxis tick={{ fontSize: 10 }} />
        <Tooltip />
        <Bar dataKey={yk} fill={color} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── 4. PieChart ───────────────────────────────────────────────────────

export function CanvasPieChart({ data }) {
  if (!data?.length) return <p className="text-xs text-gray-400 py-4 text-center">데이터 없음</p>;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={75}
          label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false}>
          {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
        </Pie>
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 11 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

// ── 5. StatCards ──────────────────────────────────────────────────────

export function CanvasStatCards({ cards }) {
  if (!cards?.length) return null;
  const colorMap = {
    green:  'bg-green-50  text-green-700  border-green-100',
    red:    'bg-red-50    text-red-700    border-red-100',
    blue:   'bg-blue-50   text-blue-700   border-blue-100',
    yellow: 'bg-yellow-50 text-yellow-700 border-yellow-100',
    gray:   'bg-gray-50   text-gray-700   border-gray-100',
  };
  return (
    <div className="grid grid-cols-2 gap-2">
      {cards.map((c, i) => (
        <div key={i} className={`rounded-lg border p-3 ${colorMap[c.color] || colorMap.blue}`}>
          <div className="text-base mb-1">{c.icon}</div>
          <div className="text-lg font-bold leading-tight">{c.value}</div>
          <div className="text-xs opacity-70 mt-0.5">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

// ── 6. JsonView ───────────────────────────────────────────────────────

export function CanvasJsonView({ data }) {
  const [copied, setCopied] = useState(false);
  const text = JSON.stringify(data, null, 2);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  return (
    <div className="relative">
      <button onClick={copy} className="absolute top-2 right-2 text-[10px] text-gray-400 hover:text-gray-600 bg-white border border-gray-200 px-2 py-0.5 rounded z-10">
        {copied ? '복사됨' : '복사'}
      </button>
      <pre className="text-xs bg-gray-50 rounded-lg p-3 pr-12 overflow-auto max-h-72 text-gray-700 font-mono leading-relaxed">{text}</pre>
    </div>
  );
}

// ── 7. CodeDiff ───────────────────────────────────────────────────────

export function CanvasCodeDiff({ files }) {
  const [active, setActive] = useState(0);
  if (!files?.length) return null;
  const file = files[active] || files[0];
  return (
    <div>
      {files.length > 1 && (
        <div className="flex gap-1 mb-2 overflow-x-auto pb-1">
          {files.map((f, i) => (
            <button key={i} onClick={() => setActive(i)}
              className={`text-xs px-2 py-1 rounded whitespace-nowrap flex-shrink-0 ${active === i ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              {f.filename?.split('/').pop()}
              {f.additions > 0 && <span className="ml-1 text-green-400">+{f.additions}</span>}
              {f.deletions > 0 && <span className="ml-0.5 text-red-400">-{f.deletions}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="text-xs font-mono overflow-auto max-h-72 bg-gray-950 rounded-lg">
        {file.hunks?.map((hunk, hi) => (
          <div key={hi}>
            <div className="px-3 py-1 text-blue-400 bg-blue-950/30 border-y border-blue-900/20 text-[10px]">{hunk.header}</div>
            {hunk.lines?.map((line, li) => (
              <div key={li} className={`px-3 py-0.5 leading-5 ${
                line.type === 'addition' ? 'bg-green-950/40 text-green-300' :
                line.type === 'deletion' ? 'bg-red-950/40  text-red-300'   : 'text-gray-400'
              }`}>
                <span className="mr-2 opacity-40 select-none w-3 inline-block">
                  {line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : ' '}
                </span>
                {line.content}
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="text-[10px] text-gray-400 mt-1.5 font-mono">
        {file.filename}
        {file.additions > 0 && <span className="ml-2 text-green-600">+{file.additions}</span>}
        {file.deletions > 0 && <span className="ml-1 text-red-500">-{file.deletions}</span>}
      </p>
    </div>
  );
}

// ── 8. CodeBlock ──────────────────────────────────────────────────────

export function CanvasCodeBlock({ code, language }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  const lines = (code || '').split('\n').length;
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        {language && <span className="text-[10px] text-gray-400 font-mono bg-gray-100 px-2 py-0.5 rounded">{language}</span>}
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-[10px] text-gray-300">{lines}줄</span>
          <button onClick={copy} className="text-[10px] text-gray-400 hover:text-gray-600 border border-gray-200 px-2 py-0.5 rounded">
            {copied ? '복사됨' : '복사'}
          </button>
        </div>
      </div>
      <pre className="text-xs bg-gray-950 text-gray-200 rounded-lg p-3 overflow-auto max-h-72 font-mono leading-relaxed">{code}</pre>
    </div>
  );
}

// ── 9. FileTree ───────────────────────────────────────────────────────

export function CanvasFileTree({ files }) {
  if (!files?.length) return null;
  const STATUS = {
    modified: { prefix: 'M', color: 'text-yellow-600' },
    added:    { prefix: 'A', color: 'text-green-600'  },
    deleted:  { prefix: 'D', color: 'text-red-600'    },
    renamed:  { prefix: 'R', color: 'text-blue-600'   },
  };
  return (
    <div className="space-y-1">
      {files.map((f, i) => {
        const s = STATUS[f.status] || STATUS.modified;
        return (
          <div key={i} className="flex items-center gap-2 text-xs font-mono p-1.5 rounded hover:bg-gray-50">
            <span className={`w-4 font-bold flex-shrink-0 ${s.color}`}>{s.prefix}</span>
            <span className="text-gray-700 flex-1 truncate">{f.path}</span>
            <span className="flex-shrink-0 text-[10px]">
              {f.additions > 0 && <span className="text-green-600">+{f.additions}</span>}
              {f.deletions > 0 && <span className="text-red-500 ml-0.5">-{f.deletions}</span>}
            </span>
          </div>
        );
      })}
      <p className="text-[10px] text-gray-400 mt-1">{files.length}개 파일</p>
    </div>
  );
}

// ── 10. StatusCard ────────────────────────────────────────────────────

export function CanvasStatusCard({ bots }) {
  if (!bots?.length) return null;
  const DOT = { online: 'bg-green-400', offline: 'bg-red-400', warning: 'bg-yellow-400', error: 'bg-red-500' };
  return (
    <div className="space-y-1.5">
      {bots.map((bot, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors">
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${DOT[bot.status] || DOT.offline}`} />
          <span className="text-sm font-medium text-gray-800">{bot.name}</span>
          <span className="text-xs text-gray-500 flex-1 text-right">{bot.detail || bot.status}</span>
        </div>
      ))}
    </div>
  );
}

// ── 11. ProgressBar ───────────────────────────────────────────────────

export function CanvasProgressBar({ current, total, label, items }) {
  const pct = total ? Math.round((current / total) * 100) : 0;
  const barColor = pct >= 90 ? 'bg-red-400' : pct >= 70 ? 'bg-yellow-400' : 'bg-primary';
  const ITEM_STATUS = {
    done:    { icon: '✅', cls: 'text-green-600' },
    running: { icon: '🔄', cls: 'text-blue-600 animate-pulse' },
    pending: { icon: '⬜', cls: 'text-gray-400' },
    error:   { icon: '❌', cls: 'text-red-600'  },
  };
  return (
    <div>
      {total != null && (
        <div className="mb-3">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>{label || `${current} / ${total}`}</span>
            <span className="font-medium">{pct}%</span>
          </div>
          <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
            <div className={`h-full ${barColor} rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
      {items?.length > 0 && (
        <div className="space-y-1">
          {items.map((item, i) => {
            const s = ITEM_STATUS[item.status] || ITEM_STATUS.pending;
            return (
              <div key={i} className={`flex items-center gap-2 text-xs ${s.cls}`}>
                <span>{s.icon}</span><span>{item.name}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── 12. Timeline ──────────────────────────────────────────────────────

export function CanvasTimeline({ events }) {
  if (!events?.length) return null;
  return (
    <div className="overflow-auto max-h-72">
      <div className="relative pl-8">
        <div className="absolute left-3 top-0 bottom-0 w-px bg-gray-100" />
        <div className="space-y-3">
          {events.map((ev, i) => (
            <div key={i} className="relative">
              <div className="absolute -left-5 w-6 h-6 rounded-full bg-white border border-gray-200 flex items-center justify-center text-xs">
                {ev.icon || '·'}
              </div>
              <p className="text-xs text-gray-700 leading-snug">{ev.text}</p>
              {ev.time && <p className="text-[10px] text-gray-400 mt-0.5">{ev.time}</p>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── 13. DynamicForm ───────────────────────────────────────────────────

export function CanvasDynamicForm({ fields, submitLabel = '적용', cancelLabel = '취소', onAction }) {
  const [values, setValues] = useState(() => {
    const v = {};
    fields?.forEach(f => { v[f.name] = f.value ?? (f.type === 'checkbox' ? false : ''); });
    return v;
  });
  const set = (name, val) => setValues(prev => ({ ...prev, [name]: val }));
  const valid = fields?.every(f => !f.required || String(values[f.name]).trim() !== '');

  return (
    <div className="space-y-3">
      {fields?.map(f => (
        <div key={f.name}>
          {f.type !== 'checkbox' && (
            <label className="block text-xs font-medium text-gray-600 mb-1">{f.label}</label>
          )}
          {f.type === 'select' ? (
            <select className="input-base text-sm" value={values[f.name]} onChange={e => set(f.name, e.target.value)}>
              {f.options?.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : f.type === 'checkbox' ? (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" className="w-4 h-4 rounded text-primary accent-primary"
                checked={!!values[f.name]} onChange={e => set(f.name, e.target.checked)} />
              <span className="text-sm text-gray-700">{f.label}</span>
            </label>
          ) : f.type === 'number' ? (
            <input type="number" className="input-base text-sm" value={values[f.name]}
              min={f.min} max={f.max} step={f.step || 'any'}
              onChange={e => set(f.name, Number(e.target.value))} />
          ) : (
            <input type="text" className="input-base text-sm" value={values[f.name]}
              placeholder={f.placeholder || ''} onChange={e => set(f.name, e.target.value)} />
          )}
        </div>
      ))}
      <div className="flex gap-2 pt-1">
        <button className="btn-primary text-sm flex-1" disabled={!valid}
          onClick={() => onAction?.({ action: 'form_submit', values })}>
          {submitLabel}
        </button>
        {cancelLabel && (
          <button className="btn-secondary text-sm flex-shrink-0"
            onClick={() => onAction?.({ action: 'cancelled' })}>
            {cancelLabel}
          </button>
        )}
      </div>
    </div>
  );
}

// ── 14. SelectDialog ──────────────────────────────────────────────────

export function CanvasSelectDialog({ options, question }) {
  // onAction은 DynamicCanvas에서 주입
  return null; // 아래 export가 실제 구현
}

// onAction을 받는 실제 컴포넌트 (COMPONENT_MAP에서 사용)
function _CanvasSelectDialog({ options, question, onAction }) {
  return (
    <div className="space-y-2">
      {question && <p className="text-sm text-gray-700 mb-3 leading-relaxed">{question}</p>}
      {options?.map((opt, i) => (
        <button key={i} onClick={() => onAction?.({ action: 'select', ...opt })}
          className="w-full text-left p-3 rounded-lg border border-gray-200 hover:border-primary hover:bg-indigo-50 transition-colors">
          <p className="text-sm font-medium text-gray-800">{opt.label}</p>
          {opt.description && <p className="text-xs text-gray-500 mt-0.5">{opt.description}</p>}
        </button>
      ))}
      <button className="w-full text-xs text-gray-400 hover:text-gray-600 py-1 mt-1"
        onClick={() => onAction?.({ action: 'cancelled' })}>취소</button>
    </div>
  );
}

// ── 15. ConfirmDialog ─────────────────────────────────────────────────

function _CanvasConfirmDialog({ message, confirmLabel = '확인', cancelLabel = '취소', details, variant = 'default', onAction }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-700 leading-relaxed">{message}</p>
      {details && <div className="text-xs bg-gray-50 rounded-lg p-2.5 text-gray-600 font-mono leading-relaxed">{details}</div>}
      <div className="flex gap-2">
        <button onClick={() => onAction?.({ action: 'confirmed' })}
          className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
            variant === 'danger' ? 'bg-red-500 hover:bg-red-600 text-white' : 'bg-gray-900 hover:bg-gray-700 text-white'}`}>
          {confirmLabel}
        </button>
        <button onClick={() => onAction?.({ action: 'cancelled' })}
          className="flex-1 py-2 rounded-lg text-sm font-medium bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors">
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}

// ── FallbackView ──────────────────────────────────────────────────────

function CanvasFallbackView({ data }) {
  return (
    <div className="text-xs text-gray-500">
      <p className="mb-1 font-medium text-gray-600">미지원 타입: <code>{data?.type}</code></p>
      <pre className="bg-gray-50 rounded p-2 overflow-auto max-h-32 text-[10px]">
        {JSON.stringify(data, null, 2).slice(0, 500)}
      </pre>
    </div>
  );
}

// ── COMPONENT_MAP ─────────────────────────────────────────────────────

const COMPONENT_MAP = {
  table:       CanvasDataTable,
  chart_line:  CanvasLineChart,
  chart_bar:   CanvasBarChart,
  chart_pie:   CanvasPieChart,
  stat_cards:  CanvasStatCards,
  json_view:   CanvasJsonView,
  code_diff:   CanvasCodeDiff,
  code_block:  CanvasCodeBlock,
  file_tree:   CanvasFileTree,
  status_card: CanvasStatusCard,
  progress:    CanvasProgressBar,
  timeline:    CanvasTimeline,
  form:        CanvasDynamicForm,
  select:      _CanvasSelectDialog,
  confirm:     _CanvasConfirmDialog,
};

// ── DynamicCanvas — 단일 컴포넌트 렌더러 ─────────────────────────────

export function DynamicCanvas({ component, onAction }) {
  if (!component) return null;
  const Component = COMPONENT_MAP[component.type];
  if (!Component) return <CanvasFallbackView data={component} />;
  return (
    <div className="text-sm">
      <Component {...component} onAction={onAction} />
    </div>
  );
}
