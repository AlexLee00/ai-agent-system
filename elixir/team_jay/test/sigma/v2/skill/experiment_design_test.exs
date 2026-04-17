defmodule Sigma.V2.Skill.ExperimentDesignTest do
  use ExUnit.Case, async: true

  alias Sigma.V2.Skill.ExperimentDesign

  defp run(params) do
    ExperimentDesign.run(params, %{})
  end

  test "perfect design passes with score 10.0" do
    {:ok, result} = run(%{
      hypothesis: "daily posts increase organic CTR",
      metric: "click_through_rate",
      baseline_defined: true,
      variant_count: 2,
      sample_size: 1000,
      has_guardrail_metric: true
    })
    assert result.passed == true
    assert result.design_score == 10.0
    assert result.issues == []
    assert result.recommendations == []
  end

  test "missing hypothesis deducts 2.5" do
    {:ok, result} = run(%{
      hypothesis: "",
      metric: "ctr",
      baseline_defined: true,
      variant_count: 2,
      sample_size: 500,
      has_guardrail_metric: true
    })
    assert "missing hypothesis" in result.issues
    assert result.design_score == Float.round(10.0 - 2.5, 1)
  end

  test "small sample size deducts 1.3" do
    {:ok, result} = run(%{
      hypothesis: "posts boost ctr",
      metric: "ctr",
      baseline_defined: true,
      variant_count: 2,
      sample_size: 100,
      has_guardrail_metric: true
    })
    assert "sample size may be too small" in result.issues
    assert result.design_score == Float.round(10.0 - 1.3, 1)
  end

  test "missing guardrail metric deducts 1.2" do
    {:ok, result} = run(%{
      hypothesis: "posts boost ctr",
      metric: "ctr",
      baseline_defined: true,
      variant_count: 2,
      sample_size: 1000,
      has_guardrail_metric: false
    })
    assert "missing guardrail metric" in result.issues
    assert result.design_score == Float.round(10.0 - 1.2, 1)
  end

  test "all issues accumulate and score floored at 0" do
    {:ok, result} = run(%{
      hypothesis: "",
      metric: "",
      baseline_defined: false,
      variant_count: 0,
      sample_size: 50,
      has_guardrail_metric: false
    })
    assert result.passed == false
    assert result.design_score == 0.0
    assert length(result.issues) == 6
  end
end
