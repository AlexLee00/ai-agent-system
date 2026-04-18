defmodule Luna.V2.LLM.RecommenderTest do
  use ExUnit.Case, async: true

  alias Luna.V2.LLM.Recommender

  describe "recommend/2" do
    test "recommend returns {:ok, map} with primary/fallback/reason/scores" do
      {:ok, result} = Recommender.recommend("luna.commander", %{})
      assert is_atom(result.primary)
      assert is_list(result.fallback)
      assert is_binary(result.reason)
      assert is_list(result.scores)
    end

    test "high urgency picks haiku over sonnet for trade_evaluation" do
      {:ok, result} = Recommender.recommend("luna.commander", %{
        urgency: :high,
        task_type: :trade_evaluation
      })
      # haiku는 urgency:high에서 +0.3, trade_evaluation에서 +0.3 보너스
      # sonnet은 urgency:high에서 -0.2, 따라서 haiku가 선택되거나 sonnet 점수가 낮아야 함
      # luna.commander의 base affinity: sonnet=1.0, haiku=0.6
      # sonnet total: 1.0 - 0.2 + 0.1 = 0.9
      # haiku total: 0.6 + 0.3 + 0.3 = 1.2 → haiku 우선
      assert result.primary == :anthropic_haiku
    end

    test "low budget (ratio < 0.10) downgrades to haiku" do
      {:ok, result} = Recommender.recommend("luna.commander", %{
        budget_ratio: 0.05
      })
      # budget_ratio < 0.10 → haiku +0.5, sonnet -1.0
      # sonnet: 1.0 - 1.0 = 0.0, haiku: 0.6 + 0.5 = 1.1
      assert result.primary == :anthropic_haiku
    end

    test "unknown agent returns default haiku recommendation" do
      {:ok, result} = Recommender.recommend("unknown.luna.agent", %{})
      assert result.primary == :anthropic_haiku
      assert is_list(result.scores)
    end

    test "scores list has correct length (matches agent affinity count)" do
      {:ok, result} = Recommender.recommend("luna.commander", %{})
      # luna.commander has affinity for haiku, sonnet, opus
      assert length(result.scores) == 3
    end
  end
end
