defmodule Jay.Core.LLM.RecommenderWeightsTest do
  use ExUnit.Case, async: false

  alias Jay.Core.LLM.RecommenderWeights

  setup do
    old_enabled = System.get_env("JAY_LLM_RECOMMENDER_WEIGHTS_ENABLED")
    old_json = System.get_env("JAY_LLM_RECOMMENDER_WEIGHTS_JSON")

    on_exit(fn ->
      restore_env("JAY_LLM_RECOMMENDER_WEIGHTS_ENABLED", old_enabled)
      restore_env("JAY_LLM_RECOMMENDER_WEIGHTS_JSON", old_json)
    end)

    :ok
  end

  test "default weights are equal and sum to 1" do
    weights = RecommenderWeights.default_weights()

    assert Enum.sort(Map.keys(weights)) == Enum.sort(RecommenderWeights.categories())
    assert_in_delta Enum.sum(Map.values(weights)), 1.0, 0.000_001
    assert Enum.all?(weights, fn {_key, value} -> value == 1.0 / 6.0 end)
  end

  test "normalize clamps floor and ceiling while preserving total weight" do
    weights =
      RecommenderWeights.normalize(%{
        length: 0.99,
        budget: 0.001,
        failure: 0.001,
        urgency: 0.001,
        task_type: 0.001,
        accuracy: 0.001
      })

    assert_in_delta Enum.sum(Map.values(weights)), 1.0, 0.000_001
    assert Enum.all?(weights, fn {_key, value} -> value >= 0.08 - 0.000_001 end)
    assert Enum.all?(weights, fn {_key, value} -> value <= 0.48 + 0.000_001 end)
  end

  test "context weights take precedence without env gate" do
    weights =
      RecommenderWeights.weights_from_context(%{
        llm_recommender_bias_weights: %{
          length: 0.24,
          budget: 0.16,
          failure: 0.16,
          urgency: 0.16,
          task_type: 0.16,
          accuracy: 0.12
        }
      })

    assert weights.length > weights.accuracy
    assert_in_delta Enum.sum(Map.values(weights)), 1.0, 0.000_001
  end

  test "env weights are ignored unless explicitly enabled" do
    System.put_env(
      "JAY_LLM_RECOMMENDER_WEIGHTS_JSON",
      ~s({"length":0.48,"budget":0.08,"failure":0.08,"urgency":0.08,"task_type":0.20,"accuracy":0.08})
    )

    System.delete_env("JAY_LLM_RECOMMENDER_WEIGHTS_ENABLED")

    assert RecommenderWeights.weights_from_context(%{}) == RecommenderWeights.default_weights()

    System.put_env("JAY_LLM_RECOMMENDER_WEIGHTS_ENABLED", "true")
    weights = RecommenderWeights.weights_from_context(%{})

    assert weights.length > weights.budget
  end

  defp restore_env(key, nil), do: System.delete_env(key)
  defp restore_env(key, value), do: System.put_env(key, value)
end
