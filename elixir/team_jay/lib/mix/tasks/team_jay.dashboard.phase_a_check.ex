defmodule Mix.Tasks.TeamJay.Dashboard.PhaseACheck do
  @moduledoc """
  Phase A LiveView dashboard readiness smoke.
  """
  use Mix.Task

  @shortdoc "Checks TeamJay Phase A dashboard wiring"

  @impl true
  def run(args) do
    json? = "--json" in args
    endpoint_config = Application.get_env(:team_jay, TeamJay.Dashboard.Endpoint, [])
    routes = TeamJay.Dashboard.Router.__routes__()
    autonomy_controller = read!("../../bots/jay/elixir/lib/jay/v2/autonomy_controller.ex")
    kv_migration = read!("priv/repo/migrations/20260521000001_create_agent_kv_store.exs")

    checks = %{
      endpoint_module_loaded: Code.ensure_loaded?(TeamJay.Dashboard.Endpoint),
      router_module_loaded: Code.ensure_loaded?(TeamJay.Dashboard.Router),
      liveview_module_loaded: Code.ensure_loaded?(TeamJay.Dashboard.Live.DashboardLive),
      health_plug_loaded: Code.ensure_loaded?(TeamJay.Dashboard.HealthPlug),
      bandit_adapter: Keyword.get(endpoint_config, :adapter) == Bandit.PhoenixAdapter,
      root_live_route: Enum.any?(routes, &(&1.path == "/" and &1.plug == Phoenix.LiveView.Plug)),
      health_alias_route:
        Enum.any?(routes, &(&1.path == "/health" or String.starts_with?(&1.path, "/health/"))),
      health_route: Enum.any?(routes, &String.starts_with?(&1.path, "/healthz")),
      endpoint_port: endpoint_port(endpoint_config) == dashboard_port(),
      dashboard_origin_localhost: dashboard_origin_allowed?(endpoint_config, "localhost"),
      dashboard_origin_loopback: dashboard_origin_allowed?(endpoint_config, "127.0.0.1"),
      team_jay_pubsub: Application.get_env(:team_jay, :dashboard_pubsub) == TeamJay.PubSub,
      jay_core_pubsub: Application.get_env(:jay_core, :dashboard_pubsub) == TeamJay.PubSub,
      autonomy_state_persistence:
        String.contains?(autonomy_controller, ~s(@state_key "jay.autonomy_controller_state")) and
          String.contains?(autonomy_controller, "save_state_to_db(new_state)") and
          String.contains?(autonomy_controller, "load_state_from_kv") and
          String.contains?(autonomy_controller, "load_state_from_event_lake") and
          String.contains?(autonomy_controller, "load_state_from_legacy_events") and
          String.contains?(autonomy_controller, "autonomy.phase_changed") and
          String.contains?(autonomy_controller, "save_state_to_repo_kv") and
          String.contains?(autonomy_controller, "master_intervention_count") and
          String.contains?(autonomy_controller, "consecutive_clean_days"),
      autonomy_kst_clock:
        String.contains?(autonomy_controller, "defp kst_today") and
          String.contains?(autonomy_controller, "Asia/Seoul") and
          not String.contains?(autonomy_controller, "Date.utc_today()"),
      growth_scheduler_visibility:
        String.contains?(dashboard_live_source(), "load_growth_scheduler_status") and
          String.contains?(dashboard_live_source(), ~s(["list", "ai.jay.growth"])) and
          String.contains?(dashboard_live_source(), "growth_scheduler_label"),
      agent_kv_store_migration:
        String.contains?(kv_migration, "CREATE TABLE IF NOT EXISTS agent.kv_store") and
          String.contains?(kv_migration, "value JSONB NOT NULL"),
      local_css: File.exists?(Path.expand("priv/static/dashboard.css", File.cwd!()))
    }

    result = %{
      ok: Enum.all?(Map.values(checks)),
      dashboard_url: "http://localhost:#{dashboard_port()}",
      checks: checks
    }

    if json? do
      Mix.shell().info(Jason.encode!(result, pretty: true))
    else
      for {name, ok?} <- checks do
        Mix.shell().info("#{if ok?, do: "ok", else: "fail"} #{name}")
      end

      Mix.shell().info("dashboard_url=#{result.dashboard_url}")
    end

    unless result.ok, do: System.halt(1)
  end

  defp endpoint_port(config) do
    config
    |> Keyword.get(:http, [])
    |> Keyword.get(:port)
  end

  defp dashboard_origin_allowed?(config, host) do
    origin = "//#{host}:#{dashboard_port()}"

    config
    |> Keyword.get(:check_origin, [])
    |> Enum.member?(origin)
  end

  defp dashboard_live_source do
    read!("lib/team_jay/dashboard/live/dashboard_live.ex")
  end

  defp dashboard_port do
    System.get_env("TEAM_JAY_DASHBOARD_PORT")
    |> Kernel.||(System.get_env("DASHBOARD_PORT"))
    |> Kernel.||("7787")
    |> String.to_integer()
  end

  defp read!(relative_or_absolute_path) do
    path =
      if Path.type(relative_or_absolute_path) == :absolute do
        relative_or_absolute_path
      else
        File.cwd!() |> Path.join(relative_or_absolute_path) |> Path.expand()
      end

    File.read!(path)
  end
end
