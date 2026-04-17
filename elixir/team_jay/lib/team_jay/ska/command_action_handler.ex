defmodule TeamJay.Ska.CommandActionHandler do
  @moduledoc """
  Ska cross-team command action handler.

  CommandInbox가 받은 typed internal event를 실제 스카 액션으로 연결하고,
  command lifecycle completed/failed를 여기서 마무리한다.
  """

  use GenServer
  require Logger

  alias TeamJay.Ska.PubSub

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    {:ok, _ref} = PubSub.subscribe(:cross_team_command_received)
    Logger.info("[SkaCommandActionHandler] 시작! cross-team action handling 활성화")
    {:ok, %{}}
  end

  @impl true
  def handle_info({:ska_event, :cross_team_command_received, %{action_type: action_type, payload: payload}}, state) do
    handle_payload(action_type, payload)
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

    TeamJay.EventLake.record(%{
      team: "ska",
      bot_name: "ska_command_action_handler",
      event_type: "ska_cross_team_command_handling",
      severity: "info",
      title: "ska cross-team command handling",
      message: "[#{pipeline}] #{kind}",
      tags: ["cross-team", "command", "ska", "handler", to_string(kind)],
      metadata: %{
        pipeline: pipeline,
        command_id: command_id,
        kind: to_string(kind),
        summary: summary,
        command: command
      }
    })

    case kind do
      :apply_seo ->
        TeamJay.Ska.Analytics.MarketingConnector.check_now()
        TeamJay.Ska.Analytics.Dashboard.refresh()

      :notify_budget_surplus ->
        TeamJay.Ska.Analytics.MarketingConnector.check_now()
        TeamJay.Ska.Analytics.Dashboard.refresh()

        pnl = Map.get(command_payload, "realized_pnl") || Map.get(command_payload, :realized_pnl) || 0

        TeamJay.HubClient.post_alarm(
          "💰 [스카팀] 운영비 예산 여유 감지\n실현 수익 반영: +$#{format_usd(pnl)}\n→ 마케팅/운영 점검 갱신",
          "ska",
          "ska.command_action_handler"
        )

      :reduce_workload ->
        apply_workload_reduction(command_payload)
        TeamJay.Ska.Analytics.Dashboard.refresh()

      _ ->
        :ok
    end

    _ =
      TeamJay.HubClient.command_complete(command_id, "ska",
        bot_name: "ska_command_action_handler",
        source: "ska.command_action_handler",
        pipeline: pipeline,
        message: "ska handled #{kind} command"
      )

    Logger.info("[SkaCommandActionHandler] #{pipeline} 처리 완료 → #{kind}")
    :ok
  rescue
    error ->
      pipeline = Map.get(payload, :pipeline, "unknown")
      command_id = Map.get(payload, :command_id, "")
      summary = Map.get(payload, :summary, "")
      command = Map.get(payload, :command, %{})

      TeamJay.EventLake.record(%{
        team: "ska",
        bot_name: "ska_command_action_handler",
        event_type: "ska_cross_team_command_action_failed",
        severity: "warn",
        title: "ska cross-team command action failed",
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
        TeamJay.HubClient.command_fail(command_id, "ska",
          bot_name: "ska_command_action_handler",
          source: "ska.command_action_handler",
          pipeline: pipeline,
          message: "ska action handler failed: #{inspect(error)}"
        )

      Logger.warning("[SkaCommandActionHandler] #{pipeline} 처리 실패: #{inspect(error)}")
      :error
  end

  defp apply_workload_reduction(command_payload) do
    risk_level = Map.get(command_payload, "risk_level") || Map.get(command_payload, :risk_level) || 0
    current_phase = TeamJay.Ska.FailureTracker.get_phase()

    if is_number(risk_level) and risk_level >= 8 and current_phase > 1 do
      TeamJay.Ska.FailureTracker.set_phase(1)
      TeamJay.Ska.TeamLead.set_phase(1)
      PubSub.broadcast_phase_changed(current_phase, 1)
    end

    TeamJay.HubClient.post_alarm(
      "⚠️ [스카팀] 시스템 위험 기반 workload reduction 적용\nrisk_level=#{risk_level}\n현재 복구 phase=#{current_phase}#{phase_note(risk_level, current_phase)}",
      "ska",
      "ska.command_action_handler"
    )
  end

  defp phase_note(risk_level, current_phase)
       when is_number(risk_level) and risk_level >= 8 and current_phase > 1,
       do: " → self-healing phase 1로 낮춤"

  defp phase_note(_risk_level, _current_phase), do: " → phase 유지"

  defp command_payload(command) when is_map(command) do
    Map.get(command, "payload") || Map.get(command, :payload) || %{}
  end

  defp command_payload(_), do: %{}

  defp format_usd(value) when is_float(value), do: :erlang.float_to_binary(value, decimals: 2)
  defp format_usd(value) when is_integer(value), do: Integer.to_string(value)
  defp format_usd(_), do: "0"
end
