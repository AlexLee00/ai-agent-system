defmodule Sigma.V2.Skill.CausalCheckTest do
  use ExUnit.Case, async: true

  alias Sigma.V2.Skill.CausalCheck

  defp run(params) do
    CausalCheck.run(params, %{})
  end

  test "empty claim + missing confounders raises risk score to high" do
    # riskScore: 2 + 2.5 (no claim) + 1.8 (no confounders) = 6.3 → "high"
    {:ok, result} = run(%{
      claim: "",
      correlation: 0.0,
      controls: [],
      confounders: [],
      sample_size: 500
    })
    assert result.causal_risk == "high"
    assert "missing causal claim" in result.flags
    assert "missing confounder review" in result.flags
  end

  test "strong correlation without controls adds flag" do
    {:ok, result} = run(%{
      claim: "blog posts cause revenue",
      correlation: 0.7,
      controls: [],
      confounders: ["promo"],
      sample_size: 500
    })
    assert "strong correlation without controls" in result.flags
    assert Enum.any?(result.recommendations, &String.contains?(&1, "baseline controls"))
  end

  test "missing confounders adds flag" do
    {:ok, result} = run(%{
      claim: "posts cause traffic",
      correlation: 0.3,
      controls: ["weekday"],
      confounders: [],
      sample_size: 500
    })
    assert "missing confounder review" in result.flags
    assert Enum.any?(result.recommendations, &String.contains?(&1, "confounders"))
  end

  test "small sample size adds flag" do
    {:ok, result} = run(%{
      claim: "posts cause revenue",
      correlation: 0.3,
      controls: ["weekday"],
      confounders: ["promo"],
      sample_size: 100
    })
    assert "small sample for causal claim" in result.flags
  end

  test "clean input returns low risk" do
    {:ok, result} = run(%{
      claim: "posting daily increases organic traffic",
      correlation: 0.6,
      controls: ["weekday", "promo"],
      confounders: ["seasonality"],
      sample_size: 600
    })
    assert result.causal_risk == "low"
    assert result.flags == []
  end

  test "recommendations are deduplicated" do
    {:ok, result} = run(%{
      claim: "",
      correlation: 0.8,
      controls: [],
      confounders: [],
      sample_size: 50
    })
    assert result.recommendations == Enum.uniq(result.recommendations)
  end
end
