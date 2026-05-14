defmodule Mix.Tasks.TeamJay.Dashboard.PhaseDCheck do
  @moduledoc """
  Phase D LiveView dashboard structure smoke.

  This check is static by design: the production dashboard usually owns port
  7787, so the task verifies source-level wiring without restarting protected
  runtimes.
  """
  use Mix.Task

  @shortdoc "Checks TeamJay Phase D dashboard wiring"

  @sigma_markers [
    "defp sigma_board",
    "load_sigma_status",
    "Sigma.V2.MapeKLoop.status()",
    "Sigma.V2.Commander",
    "Sigma.V2.Pod.Trend",
    "Sigma.V2.Pod.Growth",
    "Sigma.V2.Pod.Risk",
    "@pods_meta"
  ]

  @luna_markers [
    "defp luna_flow_board",
    "safe_luna_topics",
    "safe_jay_bus_subscribe",
    "init_luna_pipeline",
    "load_luna_pipeline_seed",
    "topic_to_stage",
    "update_luna_pipeline",
    "@luna_stages_meta",
    "@luna_topic_prefixes"
  ]

  @luna_topics [
    "luna.tv.bar",
    "luna.binance.trade",
    "luna.binance.kline",
    "luna.binance.orderbook",
    "luna.kis.tick",
    "luna.kis.quote",
    "luna.analyst.result",
    "luna.decision.candidate",
    "luna.policy.verdict",
    "luna.execution.order",
    "luna.execution.fill",
    "luna.review.trade",
    "luna.circuit.breaker"
  ]

  @impl true
  def run(args) do
    json? = "--json" in args
    dashboard_source = read!("lib/team_jay/dashboard/live/dashboard_live.ex")
    jay_bus_source = read!("../../packages/elixir_core/lib/jay/core/jay_bus.ex")

    checks = %{
      phase_d_header:
        String.contains?(dashboard_source, "Phase D • 영역 1+2+3+4+5+6+7+8") or
          String.contains?(dashboard_source, "Phase E • 영역 1+2+3+4+5+6+7+8"),
      sigma_board_rendered:
        source_order?(dashboard_source, "<.team_health_board", "<.sigma_board"),
      luna_flow_rendered: source_order?(dashboard_source, "<.sigma_board", "<.luna_flow_board"),
      sigma_markers: Enum.all?(@sigma_markers, &String.contains?(dashboard_source, &1)),
      luna_markers: Enum.all?(@luna_markers, &String.contains?(dashboard_source, &1)),
      all_luna_topics: Enum.all?(@luna_topics, &String.contains?(dashboard_source, &1)),
      refresh_sigma_luna: String.contains?(dashboard_source, ":refresh_sigma_luna"),
      luna_realtime_handler: String.contains?(dashboard_source, "luna_topic?(topic_text)"),
      jay_bus_luna_prefix_fanout:
        String.contains?(jay_bus_source, "luna_parent_topics") and
          String.contains?(jay_bus_source, "Registry.lookup(__MODULE__")
    }

    result = %{
      ok: Enum.all?(Map.values(checks)),
      dashboard_url: "http://localhost:#{dashboard_port()}",
      phase: "D",
      visualized_areas: [1, 2, 3, 4, 5, 6, 7, 8],
      checks: checks
    }

    if json? do
      Mix.shell().info(Jason.encode!(result, pretty: true))
    else
      Enum.each(checks, fn {name, ok?} ->
        Mix.shell().info("#{if ok?, do: "ok", else: "fail"} #{name}")
      end)

      Mix.shell().info("dashboard_url=#{result.dashboard_url}")
    end

    unless result.ok, do: System.halt(1)
  end

  defp read!(relative_path) do
    File.cwd!()
    |> Path.join(relative_path)
    |> Path.expand()
    |> File.read!()
  end

  defp source_order?(source, left, right) do
    case {:binary.match(source, left), :binary.match(source, right)} do
      {{left_pos, _}, {right_pos, _}} -> left_pos <= right_pos
      _ -> false
    end
  end

  defp dashboard_port do
    System.get_env("TEAM_JAY_DASHBOARD_PORT")
    |> Kernel.||(System.get_env("DASHBOARD_PORT"))
    |> Kernel.||("7787")
    |> String.to_integer()
  end
end
