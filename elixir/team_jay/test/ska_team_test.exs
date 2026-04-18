defmodule TeamJay.SkaTeamTest do
  use ExUnit.Case

  alias Jay.Core.Agents.PortAgent
  alias TeamJay.Ska.FailureTracker
  alias TeamJay.Ska.Orchestrator
  alias TeamJay.Ska.ParsingGuard

  test "ska port agents expose readable status" do
    etl = PortAgent.get_status(:ska_etl)
    report = PortAgent.get_status(:log_report)

    assert etl.name == :ska_etl
    assert etl.status in [:idle, :running]

    assert report.name == :log_report
    assert report.status in [:idle, :running]
  end

  test "ska orchestrator exposes phase and KPI shape" do
    phase = Orchestrator.get_phase()
    kpi = Orchestrator.get_kpi()

    assert phase in [1, 2, 3]
    assert is_map(kpi)
    assert Map.has_key?(kpi, :parse_success_rate)
    assert Map.has_key?(kpi, :recovery_rate)
    assert Map.has_key?(kpi, :total_failures)
    assert Map.has_key?(kpi, :auto_resolved)
  end

  test "ska failure tracker and parsing guard expose stable stats" do
    failure_stats = FailureTracker.get_stats()
    parse_stats = ParsingGuard.get_stats()

    assert is_map(failure_stats)
    assert Map.has_key?(failure_stats, :total_failures)
    assert Map.has_key?(failure_stats, :auto_resolved)
    assert Map.has_key?(failure_stats, :unresolved)
    assert Map.has_key?(failure_stats, :by_type)

    assert is_map(parse_stats)
    assert Map.has_key?(parse_stats, :level1_ok)
    assert Map.has_key?(parse_stats, :level1_fail)
    assert Map.has_key?(parse_stats, :level2_ok)
    assert Map.has_key?(parse_stats, :level2_fail)
    assert Map.has_key?(parse_stats, :level3_ok)
    assert Map.has_key?(parse_stats, :level3_fail)
  end
end
