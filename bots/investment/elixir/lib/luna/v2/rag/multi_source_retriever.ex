defmodule Luna.V2.Rag.MultiSourceRetriever do
  @moduledoc """
  Agentic RAG — 멀티소스 검색.

  pgvector HNSW 인덱스(luna_rag_documents, 1024차원)를 대상으로
  서브쿼리별 벡터 검색 수행.

  지원 카테고리: trade_review / news_memo / thesis /
               failure_case / regime_shift / analyst_insight
  임베딩: 로컬 MLX Qwen3-Embedding-0.6B
  """
  require Logger

  @embedding_url   "http://localhost:11434/api/embeddings"
  @embedding_model "qwen3-embed-0.6b"
  @top_k           5

  @valid_categories ~w[trade_review news_memo thesis failure_case regime_shift analyst_insight]

  @doc """
  서브쿼리 리스트 + 옵션으로 관련 문서 검색.

  filter 옵션:
    :category — @valid_categories 중 하나 (nil이면 전체)
    :symbol   — 특정 심볼 필터
    :market   — 특정 마켓 필터
    :limit    — 검색 결과 수 (기본 @top_k)

  반환: [%{"id" => .., "content" => .., "category" => .., "similarity" => ..}, ...]
  """
  def fetch(subqueries, filter \\ %{}) when is_list(subqueries) do
    limit = Map.get(filter, :limit, @top_k)

    docs =
      subqueries
      |> Task.async_stream(fn q -> search_one(q, filter, limit) end,
           timeout: 20_000, on_timeout: :kill_task, max_concurrency: 3)
      |> Enum.flat_map(fn
        {:ok, docs} -> docs
        _ -> []
      end)
      |> deduplicate()
      |> Enum.take(limit * 2)

    docs
  end

  @doc "단일 쿼리 벡터 검색."
  def search_one(query_text, filter \\ %{}, limit \\ @top_k) do
    with {:ok, embedding} <- embed(query_text) do
      search_by_vector(embedding, filter, limit)
    else
      _ ->
        Logger.debug("[MultiSourceRetriever] 임베딩 실패: #{String.slice(query_text, 0, 30)}")
        []
    end
  end

  @doc "MLX Qwen3-Embedding으로 텍스트 임베딩."
  def embed(text) when is_binary(text) do
    case Req.post(@embedding_url,
           json: %{model: @embedding_model, prompt: text},
           receive_timeout: 15_000) do
      {:ok, %Req.Response{status: 200, body: %{"embedding" => vec}}} when is_list(vec) ->
        {:ok, vec}
      _ ->
        {:error, :embedding_failed}
    end
  rescue
    _ -> {:error, :embedding_error}
  end

  # ─── Internal ─────────────────────────────────────────────────────

  defp search_by_vector(embedding, filter, limit) do
    vec_str = "[" <> Enum.join(Enum.map(embedding, &Float.to_string/1), ",") <> "]"

    {where_clauses, params, _} = build_filters(filter, [vec_str])
    where_sql = if where_clauses == [], do: "", else: "WHERE " <> Enum.join(where_clauses, " AND ")

    sql = """
    SELECT id, category, symbol, market, content, metadata,
           1 - (embedding <=> $1::vector) AS similarity
    FROM luna_rag_documents
    #{where_sql}
    ORDER BY embedding <=> $1::vector
    LIMIT #{limit}
    """

    case Jay.Core.Repo.query(sql, params) do
      {:ok, %{columns: cols, rows: rows}} ->
        Enum.map(rows, fn row -> cols |> Enum.zip(row) |> Enum.into(%{}) end)

      err ->
        Logger.debug("[MultiSourceRetriever] 검색 실패: #{inspect(err)}")
        []
    end
  rescue
    e ->
      Logger.error("[MultiSourceRetriever] 예외: #{inspect(e)}")
      []
  end

  defp build_filters(filter, base_params) do
    param_idx = length(base_params) + 1
    {clauses, params, idx} =
      Enum.reduce([
        {:category, filter[:category]},
        {:symbol,   filter[:symbol]},
        {:market,   filter[:market]}
      ], {[], base_params, param_idx}, fn
        {_key, nil}, acc -> acc
        {key, val}, {clauses, params, idx} ->
          col = Atom.to_string(key)
          # sanitize: only allow valid column names
          if col in ~w[category symbol market] and valid_value?(key, val) do
            {["#{col} = $#{idx}" | clauses], params ++ [to_string(val)], idx + 1}
          else
            {clauses, params, idx}
          end
      end)
    {Enum.reverse(clauses), params, idx}
  end

  defp valid_value?(:category, val), do: to_string(val) in @valid_categories
  defp valid_value?(_, _),           do: true

  defp deduplicate(docs) do
    docs
    |> Enum.uniq_by(fn d -> d["id"] || d[:id] end)
    |> Enum.sort_by(fn d -> -(d["similarity"] || d[:similarity] || 0.0) end)
  end
end
