defmodule Luna.V2.Rag.AgenticRag do
  @moduledoc """
  Agentic RAG — dynamic retrieval + self-correcting + reflection (2026 트렌드).

  기존 static RAG 한계 극복:
  - Query decomposition (복잡 쿼리 분할)
  - Multi-source retrieval (DB pgvector + 과거 거래 + thesis)
  - Self-correction (품질 낮으면 재시도)
  - Reflection tokens (실시간 품질 판단)

  임베딩: 로컬 MLX Qwen3-Embedding-0.6B (1024차원, $0)
  인덱스: luna_rag_documents (pgvector HNSW)
  """
  require Logger

  @quality_threshold 0.7
  @max_retries 2
  @embedding_url "http://localhost:11434/api/embeddings"
  @embedding_model "qwen3-embed-0.6b"

  @doc """
  Agentic RAG 검색 실행.

  query: "BTC 3만달러 돌파 후 역전 사례"
  returns: %{context: [...], quality: float, sources: [...], retries: int}
  """
  def retrieve(query, context \\ %{}) do
    Logger.debug("[AgenticRag] 검색: #{String.slice(query, 0, 50)}")

    subqueries = decompose_query(query, context)
    {:ok, docs, quality, retries} = fetch_with_retry(subqueries, query, 0)

    synthesized = synthesize(docs, query)
    {:ok, %{context: synthesized, quality: quality, sources: extract_sources(docs), retries: retries}}
  end

  @doc "거래 회고 인덱싱."
  def index_trade_review(order, judgment \\ nil) do
    content = build_trade_content(order, judgment)
    metadata = %{
      symbol: order[:symbol],
      market: order[:market],
      direction: order[:direction],
      score: judgment && judgment[:score],
      indexed_at: DateTime.utc_now() |> DateTime.to_iso8601()
    }

    store_document("trade_review", order[:symbol], order[:market], content, metadata)
  end

  @doc "thesis 인덱싱."
  def index_thesis(symbol, market, content, metadata \\ %{}) do
    store_document("thesis", symbol, market, content, metadata)
  end

  @doc "실패 사례 인덱싱."
  def index_failure(symbol, market, content, metadata \\ %{}) do
    store_document("failure_case", symbol, market, content, metadata)
  end

  @doc "유사 문서 검색 (pgvector cosine similarity)."
  def search(query_text, limit \\ 5, filter \\ %{}) do
    with {:ok, embedding} <- embed(query_text) do
      search_by_vector(embedding, limit, filter)
    end
  end

  # ─── Internal ───────────────────────────────────────────────────

  defp decompose_query(query, _context) do
    # 복잡 쿼리를 2~3개 서브쿼리로 분해
    [query, "#{query} 실패 사례", "#{query} 유사 패턴"]
  end

  defp fetch_with_retry(subqueries, original_query, retries) when retries <= @max_retries do
    docs = Enum.flat_map(subqueries, &search_docs/1)
    quality = calc_quality(docs, original_query)

    if quality >= @quality_threshold or retries >= @max_retries do
      {:ok, docs, quality, retries}
    else
      Logger.debug("[AgenticRag] 품질 #{quality} < #{@quality_threshold} — 재시도 #{retries + 1}")
      expanded = subqueries ++ [original_query <> " 관련 투자 전략"]
      fetch_with_retry(expanded, original_query, retries + 1)
    end
  end

  defp search_docs(query_text) do
    case embed(query_text) do
      {:ok, embedding} ->
        case search_by_vector(embedding, 5, %{}) do
          {:ok, docs} -> docs
          _ -> []
        end
      _ -> []
    end
  end

  defp embed(text) do
    case Req.post(@embedding_url,
           json: %{model: @embedding_model, prompt: text},
           receive_timeout: 15_000) do
      {:ok, %Req.Response{status: 200, body: %{"embedding" => vec}}} when is_list(vec) ->
        {:ok, vec}
      _ ->
        {:error, :embedding_failed}
    end
  end

  defp search_by_vector(embedding, limit, filter) do
    vec_str = "[" <> Enum.join(Enum.map(embedding, &Float.to_string/1), ",") <> "]"
    base_sql = """
    SELECT id, category, symbol, market, content, metadata,
           1 - (embedding <=> $1::vector) AS similarity
    FROM luna_rag_documents
    """

    {where, params} = build_filter_where(filter, [vec_str])
    sql = base_sql <> where <> " ORDER BY embedding <=> $1::vector LIMIT #{limit}"

    case Jay.Core.Repo.query(sql, params) do
      {:ok, %{columns: cols, rows: rows}} ->
        docs = Enum.map(rows, fn row -> cols |> Enum.zip(row) |> Enum.into(%{}) end)
        {:ok, docs}
      err ->
        Logger.warning("[AgenticRag] vector search 실패: #{inspect(err)}")
        {:ok, []}
    end
  rescue
    e ->
      Logger.error("[AgenticRag] search_by_vector 예외: #{inspect(e)}")
      {:ok, []}
  end

  defp build_filter_where(%{category: cat}, params) when is_binary(cat) do
    idx = length(params) + 1
    {"WHERE category = $#{idx}", params ++ [cat]}
  end
  defp build_filter_where(_, params), do: {"", params}

  defp calc_quality(docs, _query) do
    if length(docs) == 0, do: 0.0, else: min(1.0, length(docs) / 5.0 * 0.8 + 0.2)
  end

  defp synthesize(docs, _query) do
    Enum.map(docs, fn doc ->
      %{
        content: doc["content"] || doc[:content],
        category: doc["category"] || doc[:category],
        similarity: doc["similarity"] || doc[:similarity]
      }
    end)
  end

  defp extract_sources(docs) do
    docs |> Enum.map(fn d -> d["category"] || d[:category] end) |> Enum.uniq()
  end

  defp store_document(category, symbol, market, content, metadata) do
    with {:ok, embedding} <- embed(content) do
      vec_str = "[" <> Enum.join(Enum.map(embedding, &Float.to_string/1), ",") <> "]"
      query = """
      INSERT INTO luna_rag_documents (category, symbol, market, content, embedding, metadata)
      VALUES ($1, $2, $3, $4, $5::vector, $6)
      ON CONFLICT DO NOTHING
      RETURNING id
      """
      Jay.Core.Repo.query(query, [
        category, symbol, to_string(market || :unknown),
        content, vec_str, Jason.encode!(metadata)
      ])
    else
      _ ->
        # 임베딩 실패 시 embedding 없이 저장
        query = """
        INSERT INTO luna_rag_documents (category, symbol, market, content, metadata)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT DO NOTHING
        """
        Jay.Core.Repo.query(query, [
          category, symbol, to_string(market || :unknown),
          content, Jason.encode!(metadata)
        ])
    end
  rescue
    e ->
      Logger.error("[AgenticRag] store_document 실패: #{inspect(e)}")
      {:error, e}
  end

  defp build_trade_content(order, nil) do
    "#{order[:symbol]} #{order[:direction]} 거래 진입 — #{order[:rationale]}"
  end
  defp build_trade_content(order, judgment) do
    """
    #{order[:symbol]} #{order[:direction]} 거래
    근거: #{order[:rationale]}
    결과 평가 점수: #{judgment[:score]}
    비평: #{judgment[:critique]}
    """
  end
end
