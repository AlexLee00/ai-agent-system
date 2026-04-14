"""
bots/ska/lib/rag_client.py — 스카팀 Python RAG 유틸

packages/core/lib/rag.js와 동일한 pgvector 테이블에 접근.
OpenAI text-embedding-3-small (1536차원) 사용.

사용법:
    from bots.ska.lib.rag_client import RagClient
    rag = RagClient()
    hits = rag.search('reservations', '매출 급감 패턴', limit=3)
    rag.store('operations', '[레베카] 이상 감지: ...', metadata={'date': '2026-03-09'}, source_bot='rebecca')
"""

import os
import json
import subprocess
import psycopg2

PG_RES  = "dbname=jay options='-c search_path=reservation,public'"
SCHEMA  = 'reservation'
EMBED_MODEL = 'text-embedding-3-small'
EMBED_DIM   = 1536

# 허용 컬렉션 (rag.js와 동일)
VALID_COLLECTIONS = [
    'rag_operations', 'rag_trades', 'rag_tech',
    'rag_system_docs', 'rag_reservations', 'rag_market_data',
    'rag_schedule', 'rag_work_docs',
]


def _get_api_key():
    """llm-keys.js와 동일한 파일에서 OpenAI 키 로드"""
    key = os.environ.get('OPENAI_API_KEY', '')
    if key:
        return key
    # packages/core/lib/llm-keys.js 참조 경로에서 로드
    try:
        import subprocess, sys
        root = os.path.join(os.path.dirname(__file__), '../../../')
        result = subprocess.run(
            ['node', '-e',
             "const k=require('./packages/core/lib/llm-keys');"
             "process.stdout.write(k.getOpenAIKey()||'')"],
            cwd=root, capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except Exception:
        pass
    return ''


def _validate_collection(name):
    table = name if name.startswith('rag_') else f'rag_{name}'
    if table not in VALID_COLLECTIONS:
        raise ValueError(f'유효하지 않은 컬렉션: {name}')
    return table


def _create_embedding(text, api_key):
    """OpenAI text-embedding-3-small → 1536차원 벡터"""
    from openai import OpenAI
    client = OpenAI(api_key=api_key)
    resp = client.embeddings.create(
        model=EMBED_MODEL,
        input=text[:8000],
    )
    return resp.data[0].embedding


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
        self._api_key = _get_api_key()

    def search(self, collection, query, limit=5, threshold=None, source_bot=None):
        """
        벡터 유사도 검색 (코사인 유사도)

        반환: [{ id, content, metadata, source_bot, created_at, similarity }]
        실패 시: [] (예외 억제)
        """
        if not self._api_key:
            return []
        try:
            table = _validate_collection(collection)
            vec   = _create_embedding(query, self._api_key)
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

        if not self._api_key:
            return None
        try:
            table   = _validate_collection(collection)
            vec     = _create_embedding(content, self._api_key)
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
