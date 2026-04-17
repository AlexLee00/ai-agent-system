defmodule Darwin.V2.LLM.RecommenderTest do
  use ExUnit.Case, async: true

  alias Darwin.V2.LLM.Recommender

  describe "recommend/2 — 기본 정책" do
    test "evaluator: anthropic_sonnet 우선" do
      {:ok, result} = Recommender.recommend("evaluator", %{})
      assert result.primary in [:anthropic_sonnet, :anthropic_haiku, :anthropic_opus]
      assert is_list(result.fallback)
      assert is_binary(result.reason)
    end

    test "scanner: haiku 우선 (경량 작업)" do
      {:ok, result} = Recommender.recommend("scanner", %{})
      assert result.primary in [:anthropic_haiku, :anthropic_sonnet]
    end

    test "알 수 없는 에이전트: 기본값 반환" do
      {:ok, result} = Recommender.recommend("nonexistent_agent", %{})
      assert result.primary in [:anthropic_haiku, :anthropic_sonnet, :anthropic_opus]
    end

    test "recommend/2 scores 구조 검증" do
      {:ok, result} = Recommender.recommend("evaluator", %{})
      assert is_list(result.scores)
    end
  end
end
