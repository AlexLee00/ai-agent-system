defmodule Jay.Core.LLM.RecommenderTest do
  use ExUnit.Case, async: true

  alias Jay.Core.LLM.Recommender

  describe "length_bias/2" do
    test "haiku + 토큰 3000 → 패널티" do
      assert Recommender.length_bias(3000, :anthropic_haiku) == -0.3
    end

    test "haiku + 토큰 500 → 보너스" do
      assert Recommender.length_bias(500, :anthropic_haiku) == 0.1
    end

    test "sonnet + 토큰 6000 → 패널티" do
      assert Recommender.length_bias(6000, :anthropic_sonnet) == -0.2
    end

    test "sonnet + 토큰 1000 → 소폭 보너스" do
      assert Recommender.length_bias(1000, :anthropic_sonnet) == 0.05
    end

    test "opus는 토큰 길이 무관 0.0" do
      assert Recommender.length_bias(10_000, :anthropic_opus) == 0.0
      assert Recommender.length_bias(100, :anthropic_opus) == 0.0
    end

    test "미등록 모델 → 0.0" do
      assert Recommender.length_bias(1000, :unknown_model) == 0.0
    end
  end

  describe "budget_bias/2" do
    test "ratio 1.0 → haiku 최대 보너스 0.2" do
      assert_in_delta Recommender.budget_bias(1.0, :anthropic_haiku), 0.2, 0.0001
    end

    test "ratio 0.0 → haiku 0.0 (ratio * 0.2)" do
      assert_in_delta Recommender.budget_bias(0.0, :anthropic_haiku), 0.0, 0.0001
    end

    test "ratio 0.1 → sonnet 패널티 (ratio - 0.3 음수)" do
      assert Recommender.budget_bias(0.1, :anthropic_sonnet) < 0.0
    end

    test "ratio 0.5 → opus 패널티 (ratio - 0.6 음수)" do
      assert Recommender.budget_bias(0.5, :anthropic_opus) < 0.0
    end

    test "미등록 모델 → 0.0" do
      assert Recommender.budget_bias(0.9, :unknown_model) == 0.0
    end
  end

  describe "failure_bias/3" do
    test "실패율 > 0.3 → haiku 패널티" do
      assert Recommender.failure_bias(0.5, "agent", :anthropic_haiku) == -0.4
    end

    test "실패율 > 0.3 → sonnet 보너스" do
      assert Recommender.failure_bias(0.5, "agent", :anthropic_sonnet) == 0.2
    end

    test "실패율 0.1 → 패널티 없음" do
      assert Recommender.failure_bias(0.1, "agent", :anthropic_haiku) == 0.0
      assert Recommender.failure_bias(0.1, "agent", :anthropic_sonnet) == 0.0
    end

    test "실패율 0.0 → 0.0" do
      assert Recommender.failure_bias(0.0, "agent", :anthropic_opus) == 0.0
    end
  end

  describe "urgency_bias/2" do
    test ":high urgency → haiku 보너스" do
      assert Recommender.urgency_bias(:high, :anthropic_haiku) == 0.3
    end

    test ":high urgency → opus 패널티" do
      assert Recommender.urgency_bias(:high, :anthropic_opus) == -0.3
    end

    test ":low urgency → opus 보너스" do
      assert Recommender.urgency_bias(:low, :anthropic_opus) == 0.2
    end

    test ":medium urgency → 0.0" do
      assert Recommender.urgency_bias(:medium, :anthropic_haiku) == 0.0
      assert Recommender.urgency_bias(:medium, :anthropic_sonnet) == 0.0
    end
  end

  describe "task_type_bias/2" do
    test "binary_classification + haiku → 보너스" do
      assert Recommender.task_type_bias(:binary_classification, :anthropic_haiku) == 0.3
    end

    test "binary_classification + sonnet → 패널티" do
      assert Recommender.task_type_bias(:binary_classification, :anthropic_sonnet) == -0.2
    end

    test "code_generation + sonnet → 보너스" do
      assert Recommender.task_type_bias(:code_generation, :anthropic_sonnet) == 0.2
    end

    test "알 수 없는 task_type → 0.0" do
      assert Recommender.task_type_bias(:unknown_task, :anthropic_haiku) == 0.0
    end
  end

  describe "accuracy_bias/2" do
    test ":critical + opus → 큰 보너스" do
      assert Recommender.accuracy_bias(:critical, :anthropic_opus) == 0.5
    end

    test ":critical + haiku → 패널티" do
      assert Recommender.accuracy_bias(:critical, :anthropic_haiku) == -0.3
    end

    test ":high + sonnet → 보너스" do
      assert Recommender.accuracy_bias(:high, :anthropic_sonnet) == 0.1
    end

    test ":normal + 아무 모델 → 0.0" do
      assert Recommender.accuracy_bias(:normal, :anthropic_haiku) == 0.0
    end
  end

  describe "scores_to_recommendation/1" do
    test "최고 점수 모델이 primary" do
      scores = %{
        anthropic_haiku: 1.0,
        anthropic_sonnet: 0.5,
        anthropic_opus: 0.2
      }
      {:ok, rec} = Recommender.scores_to_recommendation(scores)
      assert rec.primary == :anthropic_haiku
      assert :anthropic_sonnet in rec.fallback
      assert :anthropic_opus in rec.fallback
    end

    test "동점 시 tier 낮은 모델 우선 (haiku < sonnet < opus)" do
      scores = %{
        anthropic_haiku: 1.0,
        anthropic_sonnet: 1.0
      }
      {:ok, rec} = Recommender.scores_to_recommendation(scores)
      assert rec.primary == :anthropic_haiku
    end

    test "빈 맵 → {:error, :no_candidates}" do
      assert {:error, :no_candidates} = Recommender.scores_to_recommendation(%{})
    end

    test "reason 바이너리 문자열 반환" do
      scores = %{anthropic_sonnet: 0.8, anthropic_haiku: 0.4}
      {:ok, rec} = Recommender.scores_to_recommendation(scores)
      assert is_binary(rec.reason)
      assert String.length(rec.reason) > 0
    end
  end
end
