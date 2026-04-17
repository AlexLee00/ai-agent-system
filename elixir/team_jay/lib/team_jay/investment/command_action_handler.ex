defmodule TeamJay.Investment.CommandActionHandler do
  @moduledoc """
  Investment cross-team command action handler.

  CommandInbox가 받은 typed internal event를 실제 투자팀 액션으로 연결하고,
  command lifecycle completed/failed를 여기서 마무리한다.
  """

  use GenServer
  require Logger

  alias TeamJay.Investment.Events
  alias TeamJay.Investment.Phase5ControlTowerSuite
  alias TeamJay.Investment.Phase5OverviewSuite
  alias TeamJay.Investment.Phase5TrendSuite
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    {:ok, _ref} = PubSub.subscribe(Topics.cross_team_commands())
    Logger.info("[InvestmentCommandActionHandler] 시작! cross-team action handling 활성화")
    {:ok, %{}}
  end

  @impl true
  def handle_info({:investment_event, topic, %{action_type: action_type, payload: payload}}, state) do
    if topic == Topics.cross_team_commands() do
      handle_payload(action_type, payload)
    end

    {:noreply, state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  defp handle_payload(kind, payload) do
    pipeline = Map.get(payload, :pipeline, "unknown")
    command_id = Map.get(payload, :command_id, "")
    summary = Map.get(payload, :summary, "")
    command = Map.get(payload, :command, %{})
    command_payload = command_payload(command)

    Jay.Core.EventLake.record(%{
      team: "investment",
      bot_name: "investment_command_action_handler",
      event_type: "investment_cross_team_command_handling",
      severity: "info",
      title: "investment cross-team command handling",
      message: "[#{pipeline}] #{kind}",
      tags: ["cross-team", "command", "investment", "handler", to_string(kind)],
      metadata: %{
        pipeline: pipeline,
        command_id: command_id,
        kind: to_string(kind),
        summary: summary,
        command: command
      }
    })

    case kind do
      :adjust_investment_intensity ->
        handle_intensity_adjustment(command_payload)

      :analyze_trend_candidates ->
        handle_trend_candidate_analysis(command_payload)

      :reduce_workload ->
        handle_workload_reduction(command_payload)

      _ ->
        :ok
    end

    case Jay.Core.HubClient.command_complete(command_id, "luna",
           bot_name: "investment_command_action_handler",
           source: "investment.command_action_handler",
           pipeline: pipeline,
           message: "investment handled #{kind} command"
         ) do
      {:ok, _} -> :ok
      {:error, reason} -> raise "command_complete failed: #{inspect(reason)}"
    end

    Logger.info("[InvestmentCommandActionHandler] #{pipeline} 처리 완료 → #{kind}")
    :ok
  rescue
    error ->
      pipeline = Map.get(payload, :pipeline, "unknown")
      command_id = Map.get(payload, :command_id, "")
      summary = Map.get(payload, :summary, "")
      command = Map.get(payload, :command, %{})

      Jay.Core.EventLake.record(%{
        team: "investment",
        bot_name: "investment_command_action_handler",
        event_type: "investment_cross_team_command_action_failed",
        severity: "warn",
        title: "investment cross-team command action failed",
        message: "[#{pipeline}] #{inspect(error)}",
        metadata: %{
          pipeline: pipeline,
          command_id: command_id,
          kind: to_string(kind),
          summary: summary,
          command: command
        }
      })

      _ =
        Jay.Core.HubClient.command_fail(command_id, "luna",
          bot_name: "investment_command_action_handler",
          source: "investment.command_action_handler",
          pipeline: pipeline,
          message: "investment action handler failed: #{inspect(error)}"
        )

      Logger.warning("[InvestmentCommandActionHandler] #{pipeline} 처리 실패: #{inspect(error)}")
      :error
  end

  defp handle_intensity_adjustment(command_payload) do
    overview = Phase5OverviewSuite.run_defaults()
    trend = Phase5TrendSuite.run_defaults()

    maybe_broadcast_runtime_override(command_payload,
      reason: :jay_cross_team_intensity_adjustment,
      recommendation: Map.get(command_payload, "intensity") || Map.get(command_payload, :intensity) || "observe",
      overview_status: overview.status,
      trend_status: trend.status
    )

    Jay.Core.HubClient.post_alarm(
      "📈 [루나팀] 투자 강도 조정 command 반영\n" <>
        "overview=#{overview.status} trend=#{trend.status}\n" <>
        "requested_intensity=#{inspect(Map.get(command_payload, "intensity") || Map.get(command_payload, :intensity) || :observe)}",
      "investment",
      "investment.command_action_handler"
    )
  end

  defp handle_trend_candidate_analysis(command_payload) do
    trend = Phase5TrendSuite.run_defaults()
    control_tower = Phase5ControlTowerSuite.run_defaults()

    Jay.Core.EventLake.record(%{
      team: "investment",
      bot_name: "investment_command_action_handler",
      event_type: "investment_trend_candidate_analysis_completed",
      severity: "info",
      title: "investment trend candidate analysis completed",
      message: "#{trend.status} / #{control_tower.status}",
      metadata: %{
        trend: trend,
        control_tower: control_tower,
        request: command_payload
      }
    })

    Jay.Core.HubClient.post_alarm(
      "🧭 [루나팀] trend candidate 분석 갱신\n" <>
        "trend=#{trend.status} (delta=#{trend.total_delta_rows})\n" <>
        "control_tower=#{control_tower.status}",
      "investment",
      "investment.command_action_handler"
    )
  end

  defp handle_workload_reduction(command_payload) do
    overview = Phase5OverviewSuite.run_defaults()
    control_tower = Phase5ControlTowerSuite.run_defaults()

    maybe_broadcast_runtime_override(command_payload,
      reason: :jay_cross_team_workload_reduction,
      recommendation: :reduce_workload,
      overview_status: overview.status,
      control_tower_status: control_tower.status
    )

    Jay.Core.HubClient.post_alarm(
      "⚠️ [루나팀] workload reduction command 반영\n" <>
        "overview=#{overview.status}\n" <>
        "control_tower=#{control_tower.status}\n" <>
        "scope=#{inspect(Map.get(command_payload, "scope") || Map.get(command_payload, :scope) || :team)}",
      "investment",
      "investment.command_action_handler"
    )
  end

  defp maybe_broadcast_runtime_override(command_payload, attrs) do
    symbol =
      Map.get(command_payload, "symbol") ||
        Map.get(command_payload, :symbol) ||
        Map.get(command_payload, "ticker") ||
        Map.get(command_payload, :ticker)

    if is_binary(symbol) and symbol != "" do
      override =
        Events.runtime_override(symbol,
          status: :requested,
          approved: false,
          overrides: [Map.new(attrs)],
          history_count: 1
        )

      PubSub.broadcast_runtime_override(symbol, {:runtime_override, override})
    end

    :ok
  end

  defp command_payload(command) when is_map(command) do
    Map.get(command, "payload") || Map.get(command, :payload) || %{}
  end

  defp command_payload(_), do: %{}
end
