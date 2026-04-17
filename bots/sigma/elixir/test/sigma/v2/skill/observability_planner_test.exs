defmodule Sigma.V2.Skill.ObservabilityPlannerTest do
  use ExUnit.Case, async: true

  alias Sigma.V2.Skill.ObservabilityPlanner

  defp run(params) do
    ObservabilityPlanner.run(params, %{})
  end

  test "base metrics always present" do
    {:ok, result} = run(%{system: "sigma", failure_modes: []})
    assert "latency" in result.metrics
    assert "error_rate" in result.metrics
    assert "throughput" in result.metrics
  end

  test "dashboards named after system" do
    {:ok, result} = run(%{system: "sigma", failure_modes: []})
    assert "sigma-health" in result.dashboards
    assert "sigma-quality" in result.dashboards
  end

  test "data_stale mode adds freshness metric and alert" do
    {:ok, result} = run(%{system: "sigma", failure_modes: ["data_stale"]})
    assert "freshness" in result.metrics
    assert "freshness threshold breach" in result.alerts
    refute "freshness metric not specified" in result.gaps
  end

  test "missing data_stale adds gap" do
    {:ok, result} = run(%{system: "sigma", failure_modes: []})
    assert "freshness metric not specified" in result.gaps
  end

  test "cost_spike mode adds cost_per_run metric" do
    {:ok, result} = run(%{system: "sigma", failure_modes: ["cost_spike"]})
    assert "cost_per_run" in result.metrics
    assert "cost spike" in result.alerts
  end

  test "quality_drop mode adds quality_score metric" do
    {:ok, result} = run(%{system: "sigma", failure_modes: ["quality_drop"]})
    assert "quality_score" in result.metrics
    assert "quality drop" in result.alerts
    refute "quality guardrail not specified" in result.gaps
  end

  test "all failure modes combined - no duplicates in metrics" do
    {:ok, result} = run(%{system: "sigma", failure_modes: ["data_stale", "cost_spike", "quality_drop"]})
    assert result.metrics == Enum.uniq(result.metrics)
    assert result.alerts == Enum.uniq(result.alerts)
    assert result.gaps == []
  end
end
