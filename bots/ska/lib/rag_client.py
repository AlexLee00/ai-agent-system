"""
bots/ska/lib/rag_client.py — 스카팀 Python RAG 유틸

packages/core/lib/rag.js와 동일한 pgvector 테이블에 접근.
Embedding 생성은 Hub LLM Gateway(`/hub/llm/embeddings`)만 사용.

사용법:
    from bots.ska.lib.rag_client import RagClient
    rag = RagClient()
    hits = rag.search('reservations', '매출 급감 패턴', limit=3)
    rag.store('operations', '[레베카] 이상 감지: ...', metadata={'date': '2026-03-09'}, source_bot='rebecca')
"""

import os
import json
import subprocess
import urllib.error
import urllib.request
import psycopg2

PG_RES  = "dbname=jay options='-c search_path=reservation,public'"
SCHEMA  = 'reservation'
HUB_BASE = os.environ.get('HUB_BASE_URL', 'http://127.0.0.1:7788').rstrip('/')
HUB_EMBED_TIMEOUT = max(5, int(os.environ.get('SKA_RAG_HUB_EMBED_TIMEOUT_SEC', '30') or '30'))

# 허용 컬렉션 (rag.js와 동일)
VALID_COLLECTIONS = [
    'rag_operations', 'rag_trades', 'rag_tech',
    'rag_system_docs', 'rag_reservations', 'rag_market_data',
    'rag_schedule', 'rag_work_docs',
]


def _validate_collection(name):
    table = name if name.startswith('rag_') else f'rag_{name}'
    if table not in VALID_COLLECTIONS:
        raise ValueError(f'유효하지 않은 컬렉션: {name}')
    return table


def _get_hub_token():
    token = os.environ.get('HUB_AUTH_TOKEN', '').strip()
    if token:
        return token

    root = os.path.join(os.path.dirname(__file__), '../../../')
    script = """
const { fetchHubSecrets } = require('./packages/core/lib/hub-client');
(async () => {
  const secrets = await fetchHubSecrets('config');
  process.stdout.write(String(secrets?.hub_auth_token || ''));
})().catch(() => process.exit(1));
"""
    try:
        result = subprocess.run(
            ['node', '-e', script],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except Exception:
        pass
    return ''


def _create_embedding(text):
    """Hub Embedding Gateway를 통해 벡터를 생성한다."""
    token = _get_hub_token()
    if not token:
        raise RuntimeError('HUB_AUTH_TOKEN 없음 — SKA RAG embedding은 Hub Gateway만 사용한다')

    payload = json.dumps({
        'callerTeam': 'ska',
        'agent': 'rebecca',
        'selectorKey': 'ska._default',
        'taskType': 'rag_embedding',
        'input': str(text or '')[:8000],
        'timeoutMs': HUB_EMBED_TIMEOUT * 1000,
    }).encode('utf-8')
    req = urllib.request.Request(
        f'{HUB_BASE}/hub/llm/embeddings',
        data=payload,
        method='POST',
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {token}',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=HUB_EMBED_TIMEOUT) as res:
            parsed = json.loads(res.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='ignore')[:300]
        raise RuntimeError(f'Hub embedding HTTP {e.code}: {body}') from e

    if not parsed.get('ok'):
        raise RuntimeError(f"Hub embedding 실패: {parsed.get('error') or 'unknown'}")
    data = parsed.get('data') or []
    embedding = data[0].get('embedding') if data and isinstance(data[0], dict) else None
    if not isinstance(embedding, list) or not embedding:
        raise RuntimeError('Hub embedding 응답에 벡터가 없음')
    return embedding


def _publish_via_reporting_hub(collection, content, metadata=None, source_bot='unknown'):
    """reporting-hub 경유 RAG 저장 (실패 시 None)"""
    try:
        root = os.path.join(os.path.dirname(__file__), '../../../')
        payload = json.dumps({
            'collection': collection,
            'content': content,
            'metadata': metadata or {},
            'source_bot': source_bot,
            'event_type': f'{source_bot}_rag',
            'message': str(content or '')[:500],
            'title': f'{source_bot} rag',
            'summary': str((metadata or {}).get('type') or source_bot),
            'details': [],
        }, ensure_ascii=False)
        script = """
const payload = JSON.parse(process.argv[1]);
const { publishToRag } = require('./packages/core/lib/reporting-hub');
const rag = require('./packages/core/lib/rag-safe');

(async () => {
  const result = await publishToRag({
    ragStore: {
      async store(collection, ragContent, metadata = {}, targetSourceBot = 'unknown') {
        return rag.store(collection, ragContent, metadata, targetSourceBot);
      },
    },
    collection: payload.collection,
    sourceBot: payload.source_bot || 'ska-python',
    event: {
      from_bot: payload.source_bot || 'ska-python',
      team: 'ska',
      event_type: payload.event_type || 'ska_python_rag',
      alert_level: 1,
      message: payload.message || String(payload.content || '').slice(0, 500),
      payload: {
        title: payload.title || 'ska rag',
        summary: payload.summary || String(payload.content || '').slice(0, 120),
        details: Array.isArray(payload.details) ? payload.details : [],
      },
    },
    metadata: payload.metadata || {},
    contentBuilder: () => payload.content || '',
  });
  process.stdout.write(JSON.stringify({ ok: true, id: result?.id ?? null }));
})().catch((error) => {
  process.stderr.write(String(error?.stack || error || 'unknown error'));
  process.exit(1);
});
"""
        result = subprocess.run(
            ['node', '-e', script, payload],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=20,
        )
        if result.returncode != 0:
            print(f'[RAG] reporting-hub publish 실패 (fallback): {result.stderr.strip() or result.stdout.strip()}')
            return None
        parsed = json.loads(result.stdout.strip() or '{}')
        return parsed.get('id')
    except Exception as e:
        print(f'[RAG] reporting-hub publish 실패 (fallback): {e}')
        return None


class RagClient:
    """스카팀 Python RAG 클라이언트"""

    def __init__(self):
        pass

    def search(self, collection, query, limit=5, threshold=None, source_bot=None):
        """
        벡터 유사도 검색 (코사인 유사도)

        반환: [{ id, content, metadata, source_bot, created_at, similarity }]
        실패 시: [] (예외 억제)
        """
        try:
            table = _validate_collection(collection)
            vec   = _create_embedding(query)
            vec_str = '[' + ','.join(str(v) for v in vec) + ']'

            conditions = []
            params = [vec_str, limit]
            idx = 3

            if threshold is not None:
                conditions.append(f'1 - (embedding <=> $1::vector) >= ${idx}')
                params.append(threshold)
                idx += 1
            if source_bot:
                conditions.append(f'source_bot = ${idx}')
                params.append(source_bot)
                idx += 1

            where = ('WHERE ' + ' AND '.join(conditions)) if conditions else ''

            sql = f"""
                SELECT id, content, metadata, source_bot, created_at,
                       1 - (embedding <=> %s::vector) AS similarity
                FROM {SCHEMA}.{table}
                {where}
                ORDER BY embedding <=> %s::vector
                LIMIT %s
            """
            # psycopg2용 파라미터 재구성
            pg_params = [vec_str, vec_str, limit]
            if threshold is not None:
                pg_params = [vec_str] + [threshold] + [vec_str, limit]
                sql = f"""
                    SELECT id, content, metadata, source_bot, created_at,
                           1 - (embedding <=> %s::vector) AS similarity
                    FROM {SCHEMA}.{table}
                    WHERE 1 - (embedding <=> %s::vector) >= %s
                    ORDER BY embedding <=> %s::vector
                    LIMIT %s
                """
                pg_params = [vec_str, vec_str, threshold, vec_str, limit]

            con = psycopg2.connect(PG_RES)
            try:
                cur = con.cursor()
                cur.execute(sql if threshold is None else sql, pg_params)
                rows = cur.fetchall()
                cur.close()
            finally:
                con.close()

            return [
                {
                    'id':         r[0],
                    'content':    r[1],
                    'metadata':   r[2] or {},
                    'source_bot': r[3],
                    'created_at': str(r[4]),
                    'similarity': float(r[5]),
                }
                for r in rows
            ]
        except Exception as e:
            print(f'[RAG] search 실패 (무시): {e}')
            return []

    def store(self, collection, content, metadata=None, source_bot='unknown'):
        """
        텍스트 임베딩 후 저장

        반환: 삽입된 id (실패 시 None)
        """
        via_hub = _publish_via_reporting_hub(collection, content, metadata, source_bot)
        if via_hub is not None:
            return via_hub

        try:
            table   = _validate_collection(collection)
            vec     = _create_embedding(content)
            vec_str = '[' + ','.join(str(v) for v in vec) + ']'
            meta    = json.dumps(metadata or {})

            con = psycopg2.connect(PG_RES)
            try:
                cur = con.cursor()
                cur.execute(
                    f"""
                    INSERT INTO {SCHEMA}.{table} (content, embedding, metadata, source_bot)
                    VALUES (%s, %s::vector, %s, %s)
                    RETURNING id
                    """,
                    (content, vec_str, meta, source_bot)
                )
                row_id = cur.fetchone()[0]
                con.commit()
                cur.close()
            finally:
                con.close()

            return row_id
        except Exception as e:
            print(f'[RAG] store 실패 (무시): {e}')
            return None
