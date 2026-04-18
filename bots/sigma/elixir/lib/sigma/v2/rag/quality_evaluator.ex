defmodule Sigma.V2.Rag.QualityEvaluator do
  @moduledoc """
  Agentic RAG — 검색 결과 품질 평가 + 재검색 판단.

  문서 관련성 점수를 집계하여 품질 임계값 미달 시 web fallback 신호.
  """

  require Logger

  @quality_threshold 0.5
  @min_docs_needed 2

  @doc """
  검색 문서 목록의 품질 점수 계산.
  반환: {:ok, %{docs: [map()], quality: float()}}
  """
  @spec score([map()], String.t()) :: {:ok, map()}
  def score(docs, _query) when is_list(docs) do
    filtered = Enum.filter(docs, &(Map.get(&1, :score, 0.0) >= 0.3))

    quality =
      if length(filtered) >= @min_docs_needed do
        avg = Enum.sum(Enum.map(filtered, &Map.get(&1, :score, 0.0))) / length(filtered)
        Float.round(avg, 3)
      else
        0.0
      end

    sorted = Enum.sort_by(filtered, &Map.get(&1, :score, 0.0), :desc)

    {:ok, %{docs: sorted, quality: quality}}
  rescue
    e ->
      Logger.warning("[Sigma.V2.Rag.QualityEvaluator] score 실패: #{inspect(e)}")
      {:ok, %{docs: [], quality: 0.0}}
  end

  @doc "품질이 임계값 미달인지 확인."
  @spec below_threshold?(float()) :: boolean()
  def below_threshold?(quality) when is_float(quality) do
    quality < @quality_threshold
  end

  @doc "기존 결과에 추가 문서를 병합하고 재점수."
  @spec merge_and_rescore(map(), [map()], String.t()) :: map()
  def merge_and_rescore(%{docs: existing_docs, quality: _quality}, new_docs, query) do
    all_docs = (existing_docs ++ new_docs) |> Enum.uniq_by(&Map.get(&1, :content))

    case score(all_docs, query) do
      {:ok, result} -> result
      _ -> %{docs: existing_docs, quality: 0.0}
    end
  end
end
