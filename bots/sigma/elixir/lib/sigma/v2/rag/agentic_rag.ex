defmodule Sigma.V2.Rag.AgenticRag do
  @moduledoc """
  시그마 Agentic RAG 진입점 (Phase D).

  기존 SelfRAG 4-gate 위에 Agentic 레이어 추가:
  1. QueryPlanner    — Directive 쿼리를 sub-query로 분해
  2. MultiSourceRetriever — L2 memory + Directive 이력 + DPO preferred 병렬 검색
  3. QualityEvaluator — 결과 품질 평가 + 재검색 판단
  4. ResponseSynthesizer — 최종 통합 응답 생성

  Kill Switch: SIGMA_AGENTIC_RAG_ENABLED=true
  OFF 상태에서는 Sigma.V2.Memory.recall/2 fallback.
  참조: Darwin.V2.Rag.AgenticRag 패턴
  """

  require Logger

  alias Sigma.V2.Rag.{
    QueryPlanner,
    MultiSourceRetriever,
    QualityEvaluator,
    ResponseSynthesizer
  }

  @doc """
  주 진입점 — 쿼리에 대한 Agentic RAG 검색 실행.

  반환:
  - kill switch OFF: Sigma.V2.Memory.recall/2 위임
  - kill switch ON:  {:ok, %{answer: String.t(), sources: [map()], quality: float()}}
  - 오류:           {:ok, %{answer: "", sources: [], quality: 0.0}}
  """
  @spec retrieve(String.t(), map()) :: {:ok, map()}
  def retrieve(query, context \\ %{}) when is_binary(query) do
    unless agentic_rag_enabled?() do
      self_rag_fallback(query, context)
    else
      do_retrieve(query, context)
    end
  end

  defp do_retrieve(query, context) do
    with {:ok, subqueries}  <- QueryPlanner.decompose(query, context),
         {:ok, raw_docs}    <- MultiSourceRetriever.fetch(subqueries, context),
         {:ok, scored}      <- QualityEvaluator.score(raw_docs, query),
         final_scored        = maybe_fallback(scored, query, context),
         {:ok, synthesized} <- ResponseSynthesizer.combine(final_scored, query) do
      {:ok, synthesized}
    else
      error ->
        Logger.warning("[Sigma.V2.Rag.AgenticRag] Agentic RAG 실패: #{inspect(error)}")
        {:ok, %{answer: "", sources: [], quality: 0.0}}
    end
  rescue
    e ->
      Logger.warning("[Sigma.V2.Rag.AgenticRag] 예외 발생: #{inspect(e)}")
      {:ok, %{answer: "", sources: [], quality: 0.0}}
  end

  defp maybe_fallback(scored, query, _context) do
    if QualityEvaluator.below_threshold?(scored.quality) do
      Logger.debug("[Sigma.V2.Rag.AgenticRag] 품질 #{scored.quality} < 임계값 — fallback 시도")
      web_docs = MultiSourceRetriever.web_search(query)
      QualityEvaluator.merge_and_rescore(scored, web_docs, query)
    else
      scored
    end
  end

  defp self_rag_fallback(query, _context) do
    case Sigma.V2.Memory.recall(query, limit: 5, threshold: 0.3) do
      {:ok, %{hits: hits}} when is_list(hits) ->
        sources = Enum.map(hits, &%{content: &1[:content] || "", source: :l2_memory, score: &1[:similarity] || 0.5})
        {:ok, %{answer: "", sources: sources, quality: 0.5}}

      _ ->
        {:ok, %{answer: "", sources: [], quality: 0.0}}
    end
  rescue
    _ -> {:ok, %{answer: "", sources: [], quality: 0.0}}
  end

  defp agentic_rag_enabled? do
    System.get_env("SIGMA_AGENTIC_RAG_ENABLED") == "true"
  end
end
