defmodule Mix.Tasks.TeamJay.Dashboard.PhaseCCheck do
  @moduledoc """
  Phase C LiveView dashboard structure smoke.

  This check is intentionally static and does not start the dashboard endpoint.
  Port 7787 is normally occupied by the protected runtime, so the smoke focuses
  on module wiring, safe fallback guards, and required Phase C sections.
  """
  use Mix.Task

  @shortdoc "Checks TeamJay Phase C dashboard wiring"

  @pipeline_topics ~w(
    ska_to_blog
    luna_to_blog
    blog_to_ska
    ska_to_luna
    claude_to_all
    blog_to_luna
    luna_to_ska
  )

  @team_keys ~w(
    ska
    luna
    blog
    claude
    jay
    sigma
    darwin
    hub
    reservation
    social-media
    master
    metty
    codex
  )

  @impl true
  def run(args) do
    json? = "--json" in args
    source_path = Path.expand("lib/team_jay/dashboard/live/dashboard_live.ex", File.cwd!())
    source = File.read!(source_path)

    checks = %{
      liveview_module_loaded: Code.ensure_loaded?(TeamJay.Dashboard.Live.DashboardLive),
      cross_team_board: String.contains?(source, "defp cross_team_board"),
      team_health_board: String.contains?(source, "defp team_health_board"),
      safe_cross_topics: String.contains?(source, "defp safe_cross_topics"),
      event_lake_pipeline_refresh: String.contains?(source, "update_pipeline_from_event"),
      agent_refresh_reload: String.contains?(source, "load_team_health()"),
      claude_to_all_highlight: String.contains?(source, "pipeline_card_class(:claude_to_all)"),
      bot_name_team_mapping: String.contains?(source, "canonical_team_key"),
      all_pipeline_topics: Enum.all?(@pipeline_topics, &String.contains?(source, &1)),
      all_team_keys: Enum.all?(@team_keys, &String.contains?(source, &1)),
      event_lake_before_phase_c_boards:
        source_order?(source, "<.event_lake_board", "<.cross_team_board"),
      phase_c_header: String.contains?(source, "Phase C • 영역 1+2+3+4+5+6")
    }

    result = %{
      ok: Enum.all?(Map.values(checks)),
      dashboard_url: "http://localhost:#{dashboard_port()}",
      phase: "C",
      visualized_areas: [1, 2, 3, 4, 5, 6],
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

  defp source_order?(source, left, right) do
    case {:binary.match(source, left), :binary.match(source, right)} do
      {{left_pos, _}, {right_pos, _}} ->
        left_pos <= right_pos

      _ ->
        false
    end
  end

  defp dashboard_port do
    System.get_env("TEAM_JAY_DASHBOARD_PORT")
    |> Kernel.||(System.get_env("DASHBOARD_PORT"))
    |> Kernel.||("7787")
    |> String.to_integer()
  end
end
