defmodule Darwin.V2.Rag.AgenticRag do
  @moduledoc """
  Agentic RAG 진입점 (Phase A, 2026 트렌드).

  기존 SelfRAG 4-gate 위에 Agentic 레이어 추가:
  1. QueryPlanner — 복잡한 쿼리를 sub-query로 분해
  2. MultiSourceRetriever — L2 memory + cycle history 병렬 검색
  3. QualityEvaluator — 결과 품질 평가 + 재검색 판단
  4. ResponseSynthesizer — 최종 통합 응답 생성

  Kill Switch: DARWIN_AGENTIC_RAG_ENABLED=true
  OFF 상태에서는 Darwin.V2.SelfRAG.recall_and_validate/2 fallback.
  """

  require Logger

  alias Darwin.V2.Rag.{
    QueryPlanner,
    MultiSourceRetriever,
    QualityEvaluator,
    ResponseSynthesizer
  }

  @doc """
  주 진입점 — 쿼리에 대한 Agentic RAG 검색 실행.

  반환:
  - kill switch OFF: Darwin.V2.SelfRAG.recall_and_validate/2 위임
  - kill switch ON:  {:ok, %{answer: String.t(), sources: [map()], quality: float()}}
  - 오류:           {:ok, %{answer: "", sources: [], quality: 0.0}}
  """
  @spec retrieve(String.t(), map()) :: {:ok, map()} | {:error, term()}
  def retrieve(query, context \\ %{}) when is_binary(query) do
    unless Darwin.V2.KillSwitch.enabled?(:agentic_rag) do
      self_rag_fallback(query, context)
    else
      do_retrieve(query, context)
    end
  end

  defp do_retrieve(query, context) do
    with {:ok, subqueries}  <- QueryPlanner.decompose(query, context),
         {:ok, raw_docs}    <- MultiSourceRetriever.fetch(subqueries, context),
         {:ok, scored}      <- QualityEvaluator.score(raw_docs, query),
         final_scored        = maybe_web_fallback(scored, query, context),
         {:ok, synthesized} <- ResponseSynthesizer.combine(final_scored, query) do
      {:ok, synthesized}
    else
      error ->
        Logger.warning("[Darwin.V2.Rag.AgenticRag] Agentic RAG 실패: #{inspect(error)}")
        {:ok, %{answer: "", sources: [], quality: 0.0}}
    end
  rescue
    e ->
      Logger.warning("[Darwin.V2.Rag.AgenticRag] 예외 발생: #{inspect(e)}")
      {:ok, %{answer: "", sources: [], quality: 0.0}}
  end

  defp maybe_web_fallback(scored, query, _context) do
    if QualityEvaluator.below_threshold?(scored.quality) do
      Logger.debug("[Darwin.V2.Rag.AgenticRag] 품질 #{scored.quality} < 임계값 — web fallback 시도")
      web_docs = MultiSourceRetriever.web_search(query)
      QualityEvaluator.merge_and_rescore(scored, web_docs, query)
    else
      scored
    end
  end

  defp self_rag_fallback(query, context) do
    case Darwin.V2.SelfRAG.recall_and_validate(query, context) do
      {:ok, docs} when is_list(docs) ->
        {:ok, %{answer: "", sources: docs, quality: 0.5}}

      {:no_passage} ->
        {:ok, %{answer: "", sources: [], quality: 0.0}}

      other ->
        Logger.debug("[Darwin.V2.Rag.AgenticRag] SelfRAG 예상외 반환: #{inspect(other)}")
        {:ok, %{answer: "", sources: [], quality: 0.0}}
    end
  rescue
    _ ->
      {:ok, %{answer: "", sources: [], quality: 0.0}}
  end
end
