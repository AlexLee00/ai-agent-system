defmodule TeamJay.Ska.Rag.AgenticRag do
  @moduledoc """
  스카팀 Agentic RAG — FailureLibrary 위 4 모듈.

  기존 FailureLibrary (L1/L2/L3) 보존 + Agentic 레이어 추가:
  1. QueryPlanner: 실패 유형 분해 (네이버 파싱/키오스크/POS 등)
  2. MultiSourceRetriever: 3계층 + Cross-Team + 과거 복구 이력
  3. QualityEvaluator: 검색 결과 품질 평가 + 재검색 자동 판단
  4. ResponseSynthesizer: 복구 전략 종합

  Kill Switch: SKA_AGENTIC_RAG_ENABLED=true (기본 false)
  Fallback: 기존 FailureLibrary 단순 조회
  """
  alias TeamJay.Ska.{FailureLibrary, KillSwitch}

  alias TeamJay.Ska.Rag.{
    QueryPlanner,
    MultiSourceRetriever,
    QualityEvaluator,
    ResponseSynthesizer
  }

  @max_retries 2

  @doc """
  실패 컨텍스트 → 복구 전략.

  failure_context: %{
    agent: :andy,
    error: :parse_failed,
    message: "셀렉터 CSS 변경",
    consecutive_failures: 3,
    selector_version: "v1.2"
  }
  """
  def retrieve_recovery_strategy(failure_context) do
    unless KillSwitch.agentic_rag_enabled?() do
      # Fallback: 기존 FailureLibrary
      FailureLibrary.ingest_failure(
        failure_context[:error] || :unknown,
        failure_context[:message] || "",
        failure_context[:agent] || :unknown
      )

      {:ok, %{strategy: :fallback_to_failure_library, confidence: 0.5,
              rationale: "Agentic RAG 비활성 — FailureLibrary 기록 완료"}}
    else
      do_agentic_retrieve(failure_context)
    end
  end

  # ─── Agentic 파이프라인 ──────────────────────────────────

  defp do_agentic_retrieve(failure_context) do
    with {:ok, subqueries} <- QueryPlanner.decompose(failure_context),
         {:ok, docs} <- MultiSourceRetriever.fetch(subqueries),
         {:ok, scored} <- QualityEvaluator.score(docs, failure_context),
         docs_final <- maybe_retry(scored, failure_context, 0),
         {:ok, strategy} <- ResponseSynthesizer.combine(docs_final, failure_context) do
      {:ok, strategy}
    end
  end

  defp maybe_retry(scored, failure_context, attempt) when attempt < @max_retries do
    if QualityEvaluator.needs_retry?(scored) do
      case MultiSourceRetriever.fetch_broader(failure_context) do
        {:ok, broader_docs} ->
          case QualityEvaluator.score(broader_docs, failure_context) do
            {:ok, rescored} -> maybe_retry(rescored, failure_context, attempt + 1)
            _ -> scored
          end

        _ ->
          scored
      end
    else
      scored
    end
  end

  defp maybe_retry(scored, _failure_context, _max), do: scored
end
