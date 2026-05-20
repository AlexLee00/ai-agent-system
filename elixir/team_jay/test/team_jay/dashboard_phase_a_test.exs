defmodule TeamJay.DashboardPhaseATest do
  use ExUnit.Case, async: true
  import Plug.Test

  test "health endpoint plug returns current dashboard phase readiness payload" do
    conn = conn(:get, "/healthz") |> TeamJay.Dashboard.HealthPlug.call([])

    assert conn.status == 200
    assert {:ok, payload} = Jason.decode(conn.resp_body)
    assert payload["ok"] == true
    assert payload["service"] == "team_jay_dashboard"
    assert payload["phase"] == "G"
    assert payload["layer"] == "Visibility v3.4 영역 1~11 + Project/Milestone/Timeline"
  end

  test "dashboard endpoint is wired to Bandit and TeamJay PubSub" do
    config = Application.get_env(:team_jay, TeamJay.Dashboard.Endpoint, [])

    assert Keyword.get(config, :adapter) == Bandit.PhoenixAdapter
    assert Keyword.get(config, :pubsub_server) == TeamJay.PubSub
    assert Application.get_env(:team_jay, :dashboard_pubsub) == TeamJay.PubSub
    assert Application.get_env(:jay_core, :dashboard_pubsub) == TeamJay.PubSub
  end

  test "router exposes root LiveView and health routes" do
    routes = TeamJay.Dashboard.Router.__routes__()

    assert Enum.any?(routes, &(&1.path == "/" and &1.plug == Phoenix.LiveView.Plug))
    assert Enum.any?(routes, &(&1.path == "/health" or String.starts_with?(&1.path, "/health/")))
    assert Enum.any?(routes, &String.starts_with?(&1.path, "/healthz"))
  end

  test "router exposes Phase E master intervention API" do
    routes = TeamJay.Dashboard.Router.__routes__()

    assert Enum.any?(
             routes,
             &(&1.verb == :post and &1.path == "/api/master-intervention" and
                 &1.plug == TeamJay.Dashboard.MasterInterventionController)
           )
  end

  test "Visibility v3.4 project marker snapshot covers Phase G area 10/11 data" do
    snapshot = TeamJay.Dashboard.ProjectVisibility.snapshot()
    marker_counts = TeamJay.Dashboard.ProjectVisibility.marker_counts()

    assert marker_counts.projects >= 4
    assert marker_counts.tasks >= 30
    assert marker_counts.milestones >= 8
    assert length(snapshot.gantt.dates) == 15
    assert Map.has_key?(snapshot.tasks_by_stage, "spec")
    assert Map.has_key?(snapshot.tasks_by_stage, "done")
  end

  test "Visibility v3.4 Cycle #52 support modules are available" do
    assert Code.ensure_loaded?(TeamJay.Dashboard.ProjectRepo)
    assert Code.ensure_loaded?(TeamJay.Dashboard.SessionTracker)
    assert Code.ensure_loaded?(TeamJay.Dashboard.MilestoneSentry)
    assert Code.ensure_loaded?(TeamJay.Dashboard.ProjectEventIngestor)
    assert function_exported?(TeamJay.Dashboard.ProjectRepo, :ingest_event, 1)
    assert function_exported?(TeamJay.Dashboard.ProjectRepo, :reconcile_milestones!, 0)
    assert function_exported?(TeamJay.Dashboard.MilestoneSentry, :reconcile_now, 0)
  end

  test "area 1 autonomy state survives runtime restarts" do
    source =
      File.read!(
        Path.expand("../../../../bots/jay/elixir/lib/jay/v2/autonomy_controller.ex", __DIR__)
      )

    migration =
      File.read!(
        Path.expand(
          "../../priv/repo/migrations/20260521000001_create_agent_kv_store.exs",
          __DIR__
        )
      )

    assert source =~ ~s(@state_key "jay.autonomy_controller_state")
    assert source =~ "load_state_from_kv"
    assert source =~ "load_state_from_repo_kv"
    assert source =~ "load_state_from_event_lake"
    assert source =~ "load_state_from_legacy_events"
    assert source =~ "kv.phase != legacy.phase"
    assert source =~ "autonomy.phase_changed"
    assert source =~ "save_state_to_db(new_state)"
    assert source =~ "save_state_to_repo_kv"
    assert source =~ "consecutive_clean_days"
    assert source =~ "master_intervention_count"
    assert source =~ "last_escalation_at"
    assert source =~ "defp kst_today"
    refute source =~ "Date.utc_today()"
    assert migration =~ "CREATE TABLE IF NOT EXISTS agent.kv_store"
    assert migration =~ "value JSONB NOT NULL"
  end

  test "area 3 exposes GrowthCycle launchd linkage" do
    source =
      File.read!(Path.expand("../../lib/team_jay/dashboard/live/dashboard_live.ex", __DIR__))

    assert source =~ "load_growth_scheduler_status"
    assert source =~ "load_growth_scheduler_schedule"
    assert source =~ "next_cycle_label(@growth_scheduler)"
    assert source =~ "growth_scheduler_warning"
    assert source =~ ~s(["list", "ai.jay.growth"])
    assert source =~ "growth_scheduler_label"
    assert source =~ "not loaded"
  end

  test "area 7 and 8 include DB-backed freshness indicators" do
    source =
      File.read!(Path.expand("../../lib/team_jay/dashboard/live/dashboard_live.ex", __DIR__))

    assert source =~ "load_sigma_event_activity"
    assert source =~ "EventLake 24h"
    assert source =~ "load_luna_operational_seed"
    assert source =~ "luna_stage_from_operational_name"
    assert source =~ "EventLake + DB 24h"
  end

  test "Visibility v3.4 session tracker detects touched-file conflicts" do
    sessions = [
      %{files_touched: ["a.ex", "b.ex"]},
      %{files_touched: ["b.ex", "c.ex"]},
      %{files_touched: ["d.ex"]}
    ]

    assert TeamJay.Dashboard.SessionTracker.count_conflicts(sessions) == 1

    assert [%{file: "b.ex", active_sessions: 2}] =
             TeamJay.Dashboard.SessionTracker.conflict_files(sessions)
  end
end
