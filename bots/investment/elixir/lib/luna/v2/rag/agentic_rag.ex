defmodule Luna.V2.Rag.AgenticRag do
  @moduledoc """
  Agentic RAG — dynamic retrieval + self-correcting + reflection (2026 트렌드).

  파이프라인:
    QueryPlanner.decompose/2
    → MultiSourceRetriever.fetch/2
    → QualityEvaluator.score/2 (< 0.7 이면 재시도, 최대 2회)
    → ResponseSynthesizer.combine/2

  임베딩: 로컬 MLX Qwen3-Embedding-0.6B (1024차원, $0)
  인덱스: luna_rag_documents (pgvector HNSW)
  """
  require Logger

  alias Luna.V2.Rag.{QueryPlanner, MultiSourceRetriever, QualityEvaluator, ResponseSynthesizer}

  @max_retries 2

  @doc """
  Agentic RAG 검색 실행.

  반환: {:ok, %{context: [...], quality: float, sources: [...], retries: int}}
  """
  def retrieve(query, context \\ %{}) do
    Logger.debug("[AgenticRag] 검색: #{String.slice(query, 0, 50)}")

    subqueries = QueryPlanner.decompose(query, context)
    {docs, quality, retries} = fetch_with_retry(subqueries, query, context, 0)

    synthesized = ResponseSynthesizer.combine(docs, query)

    {:ok, %{
      context: synthesized,
      quality: quality,
      sources: Enum.map(synthesized, & &1[:category]) |> Enum.uniq(),
      retries: retries
    }}
  end

  @doc "거래 회고 인덱싱."
  def index_trade_review(order, judgment \\ nil) do
    content = build_trade_content(order, judgment)
    metadata = %{
      symbol:     order[:symbol],
      market:     order[:market],
      direction:  order[:direction],
      score:      judgment && judgment[:score],
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
    MultiSourceRetriever.search_one(query_text, filter, limit)
    |> then(&{:ok, &1})
  end

  # ─── Internal ───────────────────────────────────────────────────

  defp fetch_with_retry(subqueries, original_query, context, retries)
       when retries <= @max_retries do
    docs    = MultiSourceRetriever.fetch(subqueries, context)
    quality = QualityEvaluator.score(docs, original_query)

    if quality >= QualityEvaluator.threshold() or retries >= @max_retries do
      {docs, quality, retries}
    else
      Logger.debug("[AgenticRag] 품질 #{quality} < #{QualityEvaluator.threshold()} — 재시도 #{retries + 1}")
      expanded = subqueries ++ ["#{original_query} 관련 투자 전략"]
      fetch_with_retry(expanded, original_query, context, retries + 1)
    end
  end

  defp store_document(category, symbol, market, content, metadata) do
    case MultiSourceRetriever.embed(content) do
      {:ok, embedding} ->
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

      _ ->
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
