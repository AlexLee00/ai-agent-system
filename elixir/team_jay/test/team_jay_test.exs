defmodule TeamJayTest do
  use ExUnit.Case
  alias TeamJay.Agents.PortAgent
  alias TeamJay.Darwin.TeamConnector
  alias TeamJay.Diagnostics
  alias TeamJay.EventLake
  alias TeamJay.MarketRegime
  alias TeamJay.Schemas.EventLake, as: EventLakeSchema
  import TeamJay.ChangesetHelpers

  test "event lake changeset requires event_type" do
    changeset = EventLakeSchema.changeset(%EventLakeSchema{}, %{})
    refute changeset.valid?
    assert "can't be blank" in errors_on(changeset).event_type
  end

  test "event lake stats api responds" do
    stats = EventLake.get_stats()
    assert is_map(stats)
    assert Map.has_key?(stats, :total)
    assert Map.has_key?(stats, :by_type)
    assert Map.has_key?(stats, :by_team)
  end

  test "market regime detects bullish trend" do
    result =
      MarketRegime.detect(%{
        aria: %{rsi: 70, trend: "up"},
        sophia: %{sentiment: 0.5}
      })

    assert result.regime == :trending_bull
    assert result.confidence > 0.0
  end

  test "port agent status is readable through registry" do
    status = PortAgent.get_status(:ska_etl)
    assert status.name == :ska_etl
    assert status.status in [:idle, :running]
  end

  test "shadow report summarizes overlap and agent states" do
    report = Diagnostics.shadow_report()
    assert is_map(report)
    assert Map.has_key?(report, :overlap_count)
    assert Map.has_key?(report, :ownership_alignment)
    assert Map.has_key?(report, :agents)
    assert Map.has_key?(report, :summary)
    assert Map.has_key?(report, :week2_shadow_agents)
    assert Map.has_key?(report, :week2_summary)
    assert Map.has_key?(report, :week3_shadow_agents)
    assert Map.has_key?(report, :week3_summary)
    assert Map.has_key?(report, :migration_candidates)
    assert Map.has_key?(report, :top_transition_candidates)
    assert Map.has_key?(report, :transition_plan)
    assert Map.has_key?(report, :pilot_runbook)
    assert Map.has_key?(report, :recommended_actions)
    assert is_list(report.agents)
    assert is_list(report.week2_shadow_agents)
    assert is_list(report.week3_shadow_agents)
    assert is_list(report.migration_candidates.week2)
    assert is_list(report.migration_candidates.week3)
    assert is_list(report.top_transition_candidates.week2)
    assert is_list(report.top_transition_candidates.week3)
    assert is_list(report.transition_plan.pilot_candidates)
    assert is_list(report.transition_plan.blockers)
    assert is_list(report.pilot_runbook.steps)
    assert Map.has_key?(report.transition_plan, :next_pilot_candidate)
    assert is_list(report.recommended_actions)
    assert Map.has_key?(report.ownership_alignment, :message)
    assert Map.has_key?(report.ownership_alignment, :missing_from_runtime)
    assert Map.has_key?(report.ownership_alignment, :missing_from_manifest)
    assert report.summary.total >= 1
    assert report.week2_summary.total == length(report.week2_shadow_agents)
    assert report.week3_summary.total == length(report.week3_shadow_agents)
    assert Map.has_key?(report.week2_summary, :required_missing)
    assert Map.has_key?(report.week2_summary, :optional_missing)
    assert Map.has_key?(report.week3_summary, :required_missing)
    assert Map.has_key?(report.week3_summary, :optional_missing)
  end

  test "shadow report can be published" do
    report = Diagnostics.publish_shadow_report()
    assert is_map(report)
    assert Map.has_key?(report, :summary)
    assert Map.has_key?(report, :week2_summary)
    assert Map.has_key?(report, :week3_summary)
    assert report.summary.total >= 1
    assert report.week2_summary.total == length(report.week2_shadow_agents)
    assert report.week3_summary.total == length(report.week3_shadow_agents)
  end

  test "diagnostics status tracks next pilot signature" do
    _report = Diagnostics.shadow_report()
    status = Diagnostics.get_status()
    assert Map.has_key?(status, :last_pilot_signature)
  end

  test "darwin team connector exposes stable status" do
    status = TeamConnector.get_status()

    assert is_map(status)
    assert status.forwarded_count >= 0
    assert status.target_teams == [:luna, :blog, :claude, :ska, :jay]
  end

  test "darwin team connector collects KPI shape" do
    kpi = TeamConnector.collect_kpi()

    assert is_map(kpi)
    assert kpi.metric_type == :research_ops
    assert Map.has_key?(kpi, :papers_7d)
    assert Map.has_key?(kpi, :high_quality_7d)
    assert Map.has_key?(kpi, :avg_score)
    assert Map.has_key?(kpi, :last_scan_at)
    assert Map.has_key?(kpi, :autonomy_level)
  end
end
