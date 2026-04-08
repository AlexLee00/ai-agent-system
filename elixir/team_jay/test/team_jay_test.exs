defmodule TeamJayTest do
  use ExUnit.Case
  alias TeamJay.Agents.PortAgent
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
    status = PortAgent.get_status(:andy)
    assert status.name == :andy
    assert status.status in [:idle, :running]
  end

  test "shadow report summarizes overlap and agent states" do
    report = Diagnostics.shadow_report()
    assert is_map(report)
    assert Map.has_key?(report, :overlap_count)
    assert Map.has_key?(report, :agents)
    assert Map.has_key?(report, :summary)
    assert Map.has_key?(report, :week2_shadow_agents)
    assert Map.has_key?(report, :week2_summary)
    assert Map.has_key?(report, :week3_shadow_agents)
    assert Map.has_key?(report, :week3_summary)
    assert Map.has_key?(report, :migration_candidates)
    assert Map.has_key?(report, :top_transition_candidates)
    assert Map.has_key?(report, :recommended_actions)
    assert is_list(report.agents)
    assert is_list(report.week2_shadow_agents)
    assert is_list(report.week3_shadow_agents)
    assert is_list(report.migration_candidates.week2)
    assert is_list(report.migration_candidates.week3)
    assert is_list(report.top_transition_candidates.week2)
    assert is_list(report.top_transition_candidates.week3)
    assert is_list(report.recommended_actions)
    assert report.summary.total >= 1
    assert report.week2_summary.total >= 1
    assert report.week3_summary.total >= 1
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
    assert report.week2_summary.total >= 1
    assert report.week3_summary.total >= 1
  end
end
