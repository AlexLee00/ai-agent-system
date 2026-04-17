defmodule Sigma.V2.Skill.FeaturePlannerTest do
  use ExUnit.Case, async: true

  alias Sigma.V2.Skill.FeaturePlanner

  defp run(params) do
    FeaturePlanner.run(params, %{})
  end

  test "empty candidates returns empty result" do
    {:ok, result} = run(%{candidates: []})
    assert result.ranked_features == []
    assert result.high_risk_features == []
    assert result.quick_wins == []
  end

  test "prioritizes by score: signal*2 - effort - leakage_penalty" do
    candidates = [
      %{name: "low_score", effort: 8, signal: 1, leakage_risk: false},
      %{name: "high_score", effort: 2, signal: 5, leakage_risk: false}
    ]
    {:ok, result} = run(%{candidates: candidates})
    [first | _] = result.ranked_features
    assert first.name == "high_score"
  end

  test "leakage_risk features go to high_risk_features" do
    candidates = [
      %{name: "risky", effort: 2, signal: 5, leakage_risk: true},
      %{name: "safe", effort: 2, signal: 5, leakage_risk: false}
    ]
    {:ok, result} = run(%{candidates: candidates})
    names = Enum.map(result.high_risk_features, & &1.name)
    assert "risky" in names
    refute "safe" in names
  end

  test "low effort + high signal + no leakage = quick win" do
    candidates = [
      %{name: "quick", effort: 2, signal: 4, leakage_risk: false},
      %{name: "slow", effort: 8, signal: 4, leakage_risk: false},
      %{name: "risky_quick", effort: 2, signal: 4, leakage_risk: true}
    ]
    {:ok, result} = run(%{candidates: candidates})
    qw_names = Enum.map(result.quick_wins, & &1.name)
    assert "quick" in qw_names
    refute "slow" in qw_names
    refute "risky_quick" in qw_names
  end

  test "score formula: signal*2 - effort - (leakage ? 2 : 0)" do
    candidates = [%{name: "f", effort: 3, signal: 4, leakage_risk: true}]
    {:ok, result} = run(%{candidates: candidates})
    [item] = result.ranked_features
    expected = Float.round(4.0 * 2 - 3.0 - 2.0, 1)
    assert item.score == expected
  end
end
